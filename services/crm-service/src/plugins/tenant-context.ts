/**
 * @file services/crm-service/src/plugins/tenant-context.ts
 * @description Fastify plugin that extracts tenant context from the verified JWT,
 * attaches it to request, and sets up the RLS-scoped database client.
 * Must run AFTER the auth middleware has verified the token.
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getTenantClient } from '@vertex/shared/utils/database';
import { createLogger, type Logger } from '@vertex/shared/utils/logger';
import type { TenantId, UserId } from '@vertex/shared/types';

const logger = createLogger('tenant-context');

// ─── Augment Fastify request ─────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: TenantId;
    userId: UserId;
    userRole: string;
    /** RLS-scoped database query function */
    db: Awaited<ReturnType<typeof getTenantClient>>;
    /** Request-scoped structured logger */
    vlog: Logger;
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

    // Context populated by auth middleware (auth.ts sets request.tenantContext)
    const ctx = request.tenantContext;
    if (!ctx?.tenantId || !ctx?.userId) {
      return reply.code(401).send({
        success: false,
        error: { code: 'MISSING_CONTEXT', message: 'Authentication required' },
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }

    // Attach to request
    request.tenantId = ctx.tenantId;
    request.userId = ctx.userId;
    request.userRole = ctx.role ?? 'viewer';

    // Create RLS-scoped DB client (SET LOCAL app.current_tenant_id)
    try {
      request.db = await getTenantClient(ctx.tenantId);
    } catch (err) {
      logger.error('Failed to create tenant DB client', err, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      });
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
  dependencies: ['auth-middleware'],
});
