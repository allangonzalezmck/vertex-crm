/**
 * @file services/crm-service/src/app.ts
 * @description CRM Service — manages Leads, Contacts, Accounts, Deals, Activities.
 * Fastify application factory. Registered as a Cloud Run service.
 *
 * Architecture: Fastify over Express for lower overhead, native async/await,
 * and JSON schema validation at the framework level (supplements our Zod layer).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyCors } from '@fastify/cors';
import { fastifyHelmet } from '@fastify/helmet';
import { fastifyRateLimit } from '@fastify/rate-limit';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

import { createPool, buildDatabaseConfig, checkDatabaseHealth } from '../../../shared/src/utils/database.js';
import { createLogger } from '../../../shared/src/utils/logger.js';
import { leadsRouter } from './routes/leads.js';
import { contactsRouter } from './routes/contacts.js';
import { dealsRouter } from './routes/deals.js';
import { activitiesRouter } from './routes/activities.js';
import { pipelinesRouter } from './routes/pipelines.js';
import { conversationsExportRouter } from './routes/conversations-export.js';
import { conversationsImportRouter } from './routes/conversations-import.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantContextPlugin } from './plugins/tenant-context.js';
import { errorHandler } from './middleware/error-handler.js';

const SERVICE_NAME = 'crm-service';
const SERVICE_VERSION = process.env['SERVICE_VERSION'] ?? '1.0.0';

export async function buildApp(): Promise<FastifyInstance> {
  const logger = createLogger(SERVICE_NAME, SERVICE_VERSION);

  const app = Fastify({
    // Disable built-in logger — use our structured logger instead
    logger: false,
    // Add request ID to every request
    genReqId: () => randomUUID(),
    // Trust Cloud Run's load balancer for IP forwarding
    trustProxy: true,
  });

  // ─── Infrastructure Plugins ─────────────────────────────────────────────

  // CORS — allow tenant subdomains + dashboard origin
  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      // In production, validate against tenant's allowed origins from DB
      // For now: allow any HTTPS origin + localhost for dev
      if (
        !origin ||
        origin.startsWith('https://') ||
        origin.includes('localhost')
      ) {
        callback(null, true);
      } else {
        callback(new Error('CORS blocked'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID', 'X-Tenant-ID'],
  });

  // Security headers
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // handled by frontend/CDN
  });

  // Rate limiting — backed by Redis for consistency across instances
  const redis = new Redis({
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    password: process.env['REDIS_PASSWORD'],
    tls: process.env['REDIS_TLS'] === 'true' ? {} : undefined,
    lazyConnect: true,
    enableReadyCheck: false,
  });

  await app.register(fastifyRateLimit, {
    max: 1000, // per tenant per minute (enforced at gateway too, this is defense-in-depth)
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Rate limit by tenant ID, not IP (IP may be shared in enterprise)
      return (request.headers['x-tenant-id'] as string) ?? request.ip;
    },
    redis,
    errorResponseBuilder: () => ({
      data: null,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down.',
        requestId: randomUUID(),
      },
      meta: { requestId: randomUUID(), timestamp: new Date().toISOString() },
    }),
  });

  // ─── Database ───────────────────────────────────────────────────────────

  const dbConfig = buildDatabaseConfig();
  createPool(dbConfig);
  logger.info('Database pool initialized');

  // ─── Request Lifecycle Hooks ─────────────────────────────────────────────

  // Attach request-scoped logger with trace context
  app.addHook('onRequest', async (request) => {
    const traceHeader = request.headers['x-cloud-trace-context'] as string | undefined;
    const traceId = traceHeader?.split('/')[0];

    (request as typeof request & { log: typeof logger }).log = logger.child({
      requestId: request.id,
      method: request.method,
      url: request.url,
      traceId,
    });
  });

  // Log all requests
  app.addHook('onResponse', async (request, reply) => {
    const reqLog = (request as typeof request & { log: typeof logger }).log;
    reqLog.info('Request completed', {
      statusCode: reply.statusCode,
      duration: reply.elapsedTime,
    });
  });

  // ─── Auth & Tenant Context ───────────────────────────────────────────────

  await app.register(authMiddleware);
  await app.register(tenantContextPlugin);

  // ─── Routes ─────────────────────────────────────────────────────────────

  await app.register(async (instance) => {
    await instance.register(leadsRouter, { prefix: '/leads' });
    await instance.register(contactsRouter, { prefix: '/contacts' });
    await instance.register(dealsRouter, { prefix: '/deals' });
    await instance.register(activitiesRouter, { prefix: '/activities' });
    await instance.register(pipelinesRouter, { prefix: '/pipelines' });
    // GAP-04 (export) + GAP-05 (import): tenant conversation data portability
    await instance.register(conversationsExportRouter, { prefix: '/conversations' });
    await instance.register(conversationsImportRouter, { prefix: '/conversations' });
  }, { prefix: '/api/v1' });

  // ─── Health & Readiness ──────────────────────────────────────────────────

  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/ready', async (_request, reply) => {
    const [dbHealthy] = await Promise.all([
      checkDatabaseHealth(),
    ]);

    if (!dbHealthy) {
      reply.status(503).send({ status: 'unavailable', checks: { database: false } });
      return;
    }

    return { status: 'ready', checks: { database: true } };
  });

  // ─── Error Handler ───────────────────────────────────────────────────────

  app.setErrorHandler(errorHandler(logger));

  // ─── Graceful Shutdown ───────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown`);
    await app.close();
    await redis.quit();
    logger.info('CRM service shut down cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return app;
}
