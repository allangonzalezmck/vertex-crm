/**
 * @file services/crm-service/src/plugins/tenant-context.ts
 * @description Fastify plugin that extracts tenant_id from the verified JWT,
 * attaches it to request, and sets up the RLS-scoped database client.
 * Must run AFTER the auth middleware has verified the token.
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getTenantClient } from '@vertex/shared/utils/database';
import { logger } from '@vertex/shared/utils/logger';
import type { TenantId, UserId } from '@vertex/shared/types';

// ─── Augment Fastify request ─────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: TenantId;
    userId: UserId;
    userRole: string;
    /** RLS-scoped database query function */
    db: Awaited<ReturnType<typeof getTenantClient>>;
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const tenantContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip public routes
    const url = request.url;
    if (url === '/health' || url === '/ready' || url === '/metrics') {
      return;
    }

    // JWT claims populated by auth middleware
    const claims = (request as any).jwtClaims;
    if (!claims?.tenant_id || !claims?.sub) {
      return reply.code(401).send({
        success: false,
        error: { code: 'MISSING_CONTEXT', message: 'Authentication required' },
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }

    const tenantId = claims.tenant_id as TenantId;
    const userId = claims.sub as UserId;
    const userRole = claims.role ?? 'viewer';

    // Attach to request
    request.tenantId = tenantId;
    request.userId = userId;
    request.userRole = userRole;

    // Create RLS-scoped DB client (SET LOCAL app.current_tenant_id)
    try {
      request.db = await getTenantClient(tenantId);
    } catch (err) {
      logger.error({ err, tenantId, userId }, 'Failed to create tenant DB client');
      return reply.code(503).send({
        success: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' },
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }
  });

  // Release client connection after response
  fastify.addHook('onResponse', async (request: FastifyRequest) => {
    if ((request as any).db?.release) {
      try {
        await (request as any).db.release();
      } catch {
        // Best-effort release
      }
    }
  });
};

export default fp(tenantContextPlugin, {
  name: 'tenant-context',
  dependencies: ['auth'],
});
