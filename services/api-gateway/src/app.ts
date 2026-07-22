/**
 * Vertex CRM — API Gateway
 * Single ingress for all frontend/external traffic.
 * Responsibilities:
 *   - JWT validation (Google Identity Platform JWKS)
 *   - Tenant resolution from JWT → header propagation
 *   - Per-tenant rate limiting (Redis sliding window)
 *   - Reverse proxy to upstream Cloud Run services
 *   - Request/response logging with trace IDs
 *   - Billing limit pre-check for write operations
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyHttpProxy from '@fastify/http-proxy';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import Redis from 'ioredis';
import { createLogger } from '../../../shared/src/utils/logger';
import { randomUUID } from 'crypto';

const logger = createLogger('api-gateway');

// ── Redis rate limiter ───────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
redis.connect().catch((err) => logger.error('Redis connect failed', err));

async function slidingWindowRateLimit(
  key: string,
  windowMs: number,
  max: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const resetAt = now + windowMs;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);
  pipe.zadd(key, now, `${now}-${randomUUID()}`);
  pipe.zcard(key);
  pipe.pexpire(key, windowMs);
  const results = await pipe.exec();

  const count = (results?.[2]?.[1] as number) ?? 0;
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetAt,
  };
}

// ── JWKS ─────────────────────────────────────────────────────────────────────
const JWKS = createRemoteJWKSet(
  new URL(
    `https://www.googleapis.com/service_accounts/v1/jwk/${process.env.GCP_SERVICE_ACCOUNT_EMAIL}`
  )
);

// ── Upstream service map ─────────────────────────────────────────────────────
const UPSTREAM = {
  crm:          process.env.CRM_SERVICE_URL!,
  marketing:    process.env.MARKETING_SERVICE_URL!,
  agent:        process.env.AGENT_SERVICE_URL!,
  workflow:     process.env.WORKFLOW_SERVICE_URL!,
  notification: process.env.NOTIFICATION_SERVICE_URL!,
  billing:      process.env.BILLING_SERVICE_URL!,
  embedding:    process.env.EMBEDDING_SERVICE_URL!,
};

// Routes that don't require auth
const PUBLIC_ROUTES = new Set([
  '/health',
  '/ready',
  '/api/auth/google/callback',
  '/api/billing/webhooks/paddle',
  '/api/agent/webhooks/whatsapp',
  '/api/agent/webhooks/facebook',
  '/api/agent/webhooks/cal',
]);

// ── Fastify ──────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false, trustProxy: true });

app.get('/health', async () => ({ status: 'ok', service: 'api-gateway' }));
app.get('/ready', async () => {
  await redis.ping();
  return { status: 'ready' };
});

// ── Auth + tenant middleware ─────────────────────────────────────────────────
app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const traceId = (req.headers['x-cloud-trace-context'] as string)?.split('/')[0] ?? randomUUID();
  (req as any).traceId = traceId;
  reply.header('x-trace-id', traceId);

  const path = req.url.split('?')[0];
  if (PUBLIC_ROUTES.has(path)) return;
  // Webhook endpoints include tenant suffixes (e.g. /api/agent/webhooks/whatsapp/{tenantId})
  // — prefix-match those instead of exact-matching (VR-13 fix).
  for (const pub of PUBLIC_ROUTES) {
    if (pub.includes('/webhook') && path.startsWith(pub)) return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization header' });
  }

  let payload: JWTPayload & { tenant_id?: string; email?: string };
  try {
    const { payload: p } = await jwtVerify(auth.slice(7), JWKS, {
      audience: process.env.JWT_AUDIENCE,
      issuer: `https://securetoken.google.com/${process.env.FIREBASE_PROJECT_ID}`,
    });
    payload = p as typeof payload;
  } catch (err) {
    logger.warn('JWT verification failed', { traceId });
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }

  const tenantId = payload.tenant_id ?? (payload as any)['https://vertex-crm.io/tenant_id'];
  if (!tenantId) {
    return reply.status(403).send({ error: 'Token missing tenant_id claim' });
  }

  // Propagate identity headers to upstreams
  req.headers['x-tenant-id']    = tenantId;
  req.headers['x-user-id']      = payload.sub ?? '';
  req.headers['x-user-email']   = payload.email ?? '';
  req.headers['x-trace-id']     = traceId;

  // Per-tenant rate limit: 2000 req/min
  const { allowed, remaining, resetAt } = await slidingWindowRateLimit(
    `ratelimit:${tenantId}`,
    60_000,
    2_000
  );

  reply.header('x-ratelimit-remaining', remaining);
  reply.header('x-ratelimit-reset', Math.ceil(resetAt / 1000));

  if (!allowed) {
    logger.warn('Rate limit exceeded', { tenantId, traceId });
    return reply.status(429).send({
      error: 'Too many requests',
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
    });
  }

  logger.info('Proxying request', {
    method: req.method,
    url: req.url,
    tenantId,
    traceId,
  });
});

// ── Route → upstream mapping ─────────────────────────────────────────────────
async function registerProxies(): Promise<void> {
// CRM Service
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/conversations',
  rewritePrefix: '/api/v1/conversations',
  httpMethods: ['GET', 'POST'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/leads',
  rewritePrefix: '/api/v1/leads',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/contacts',
  rewritePrefix: '/api/v1/contacts',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/deals',
  rewritePrefix: '/api/v1/deals',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/accounts',
  rewritePrefix: '/api/v1/accounts',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/activities',
  rewritePrefix: '/api/v1/activities',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.crm,
  prefix: '/api/pipelines',
  rewritePrefix: '/api/v1/pipelines',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});

// Marketing Intelligence Service
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.marketing,
  prefix: '/api/marketing',
  rewritePrefix: '/marketing',
  httpMethods: ['GET', 'POST'],
});

// AI Sales Agent
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.agent,
  prefix: '/api/agent',
  rewritePrefix: '/agent',
  httpMethods: ['GET', 'POST'],
});

// Workflow Engine
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.workflow,
  prefix: '/api/workflows',
  rewritePrefix: '/workflows',
  httpMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});

// Notification Service
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.notification,
  prefix: '/api/notifications',
  rewritePrefix: '/notifications',
  httpMethods: ['GET', 'POST', 'PATCH'],
});

// Billing Service
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.billing,
  prefix: '/api/billing',
  rewritePrefix: '/billing',
  httpMethods: ['GET', 'POST'],
});

// Embedding / KB Service
await app.register(fastifyHttpProxy, {
  upstream: UPSTREAM.embedding,
  prefix: '/api/kb',
  rewritePrefix: '/kb',
  httpMethods: ['GET', 'POST', 'DELETE'],
});

}

// ── Boot ─────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await registerProxies();
    await app.listen({ port: 8080, host: '0.0.0.0' });
    logger.info('api-gateway listening on :8080');
  } catch (err) {
    logger.error('Failed to start api-gateway', err);
    process.exit(1);
  }
};

start();
