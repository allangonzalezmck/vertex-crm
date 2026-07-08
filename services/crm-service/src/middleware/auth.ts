/**
 * @file services/crm-service/src/middleware/auth.ts
 * @description JWT validation middleware for all CRM service routes.
 * Validates Google Identity Platform JWTs and extracts tenant context.
 * The api-gateway verifies tokens before forwarding, but we verify again
 * (defense in depth) and extract claims for downstream use.
 *
 * Architecture note: We validate the JWT against Identity Platform's JWKS
 * endpoint with 1-hour caching. The tenant_id is read from a custom claim
 * set during login, never from client-supplied headers.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import * as jose from 'jose';
import type { TenantContext } from '../../../../shared/src/types/index.js';
import { asTenantId, asUserId, type UserRole, type Permission } from '../../../../shared/src/types/index.js';

// Public key cache — refreshes every hour
let jwksCache: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL_MS = 3600 * 1000; // 1 hour

function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
  const now = Date.now();
  if (!jwksCache || now - jwksCacheTime > JWKS_CACHE_TTL_MS) {
    const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? '';
    const jwksUrl = new URL(
      `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`
    );
    jwksCache = jose.createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: JWKS_CACHE_TTL_MS,
    });
    jwksCacheTime = now;
  }
  return jwksCache!;
}

// Routes that bypass auth (health checks)
const PUBLIC_ROUTES = new Set(['/health', '/ready']);

// Role → permissions mapping
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: ['leads:read', 'leads:write', 'leads:delete', 'contacts:read', 'contacts:write', 'contacts:delete', 'deals:read', 'deals:write', 'deals:delete', 'marketing:read', 'marketing:connect', 'ai_agent:read', 'ai_agent:configure', 'workflows:read', 'workflows:write', 'billing:read', 'billing:write', 'admin:read', 'admin:write', 'audit_log:read'],
  admin: ['leads:read', 'leads:write', 'leads:delete', 'contacts:read', 'contacts:write', 'contacts:delete', 'deals:read', 'deals:write', 'deals:delete', 'marketing:read', 'marketing:connect', 'ai_agent:read', 'ai_agent:configure', 'workflows:read', 'workflows:write', 'billing:read', 'admin:read', 'admin:write', 'audit_log:read'],
  manager: ['leads:read', 'leads:write', 'contacts:read', 'contacts:write', 'deals:read', 'deals:write', 'marketing:read', 'ai_agent:read', 'workflows:read', 'workflows:write'],
  sales_rep: ['leads:read', 'leads:write', 'contacts:read', 'contacts:write', 'deals:read', 'deals:write'],
  marketing: ['leads:read', 'contacts:read', 'marketing:read', 'marketing:connect', 'ai_agent:read'],
  viewer: ['leads:read', 'contacts:read', 'deals:read', 'marketing:read'],
};

async function authMiddlewareFn(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    // Skip auth for health/ready endpoints
    if (PUBLIC_ROUTES.has(request.url)) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header', requestId: request.id },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
      });
    }

    const token = authHeader.slice(7);

    try {
      const jwks = getJwks();
      const { payload } = await jose.jwtVerify(token, jwks, {
        issuer: `https://securetoken.google.com/${process.env['GOOGLE_CLOUD_PROJECT']}`,
        audience: process.env['GOOGLE_CLOUD_PROJECT'],
      });

      // Custom claims set by Identity Platform during login
      // These are set by the auth service when user logs in
      const tenantId = payload['vertex_tenant_id'] as string | undefined;
      const userId = payload['sub'] as string | undefined;
      const role = (payload['vertex_role'] ?? 'viewer') as UserRole;
      const plan = (payload['vertex_plan'] ?? 'standard') as TenantContext['plan'];

      if (!tenantId || !userId) {
        return reply.status(401).send({
          data: null,
          error: { code: 'INVALID_TOKEN', message: 'Token missing required claims', requestId: request.id },
          meta: { requestId: request.id, timestamp: new Date().toISOString() },
        });
      }

      // Attach context to request — downstream handlers read from here, never headers
      request.tenantContext = {
        tenantId: asTenantId(tenantId),
        userId: asUserId(userId),
        role,
        plan,
        permissions: ROLE_PERMISSIONS[role] ?? [],
        sessionId: payload['jti'] as string ?? '',
      };
    } catch (err) {
      // Distinguish token expiry from invalid signature
      const isExpired = err instanceof jose.errors.JWTExpired;
      return reply.status(401).send({
        data: null,
        error: {
          code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
          message: isExpired ? 'Token has expired' : 'Invalid token',
          requestId: request.id,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
      });
    }
  });
}

export const authMiddleware = fp(authMiddlewareFn, {
  name: 'auth-middleware',
});

/**
 * Permission guard decorator for route handlers.
 * Use as a preHandler hook on individual routes requiring specific permissions.
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenantContext.permissions.includes(permission)) {
      return reply.status(403).send({
        data: null,
        error: {
          code: 'FORBIDDEN',
          message: `You don't have permission to perform this action`,
          requestId: request.id,
        },
        meta: { requestId: request.id, timestamp: new Date().toISOString() },
      });
    }
  };
}
