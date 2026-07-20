/**
 * @file services/marketing-intelligence/src/app.ts
 * @description Marketing Intelligence service — Fastify bootstrap.
 * Orchestrates connector syncs, BigQuery ingestion, and metric query APIs.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import { createLogger } from '../../../shared/src/utils/logger.js';
import { createSuccessResponse, createErrorResponse } from '../../../shared/src/schemas/index.js';
import { MetaConnector } from './connectors/meta.connector.js';
import { TikTokConnector } from './connectors/tiktok.connector.js';
import { GoogleAdsConnector } from './connectors/google-ads.connector.js';
import { BigQueryIngestionService } from './services/bigquery.service.js';
import { SyncJobService } from './services/sync-job.service.js';
import Redis from 'ioredis';

const logger = createLogger('marketing-intelligence');

const SyncRequestSchema = z.object({
  tenantId: z.string().min(1),
  platform: z.enum(['meta', 'tiktok', 'google']),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['incremental', 'backfill']).default('incremental'),
});

const MetricsQuerySchema = z.object({
  tenantId: z.string().min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platforms: z.array(z.enum(['meta', 'tiktok', 'google'])).optional(),
  groupBy: z.array(z.string()).min(1).max(5),
  metrics: z.array(z.string()).min(1).max(15),
});

export async function buildApp() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    requestIdHeader: 'x-cloud-trace-context',
  });

  const redis = new Redis({
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
    password: process.env['REDIS_PASSWORD'],
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  const bqService = new BigQueryIngestionService(
    process.env['GCP_PROJECT_ID'] ?? '',
    logger
  );

  const syncJobService = new SyncJobService(redis, bqService, logger);

  // ─── Health ──────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ status: 'ok' }));

  /** GAP-01: daily token expiry sweep (Cloud Scheduler). */
  app.post('/internal/token-sweep', async () => {
    const { MetaTokenManager } = await import('./connectors/meta-token-manager.js');
    const { Pool } = await import('pg');
    const mgr = new MetaTokenManager(new Pool({ connectionString: process.env['DATABASE_URL'] }));
    return mgr.sweepExpiring(7);
  });

  app.get('/ready', async (req, reply) => {
    try {
      await redis.ping();
      reply.send({ status: 'ready' });
    } catch {
      reply.status(503).send({ status: 'not_ready' });
    }
  });

  // ─── Sync Trigger ────────────────────────────────────────────────────────

  /**
   * POST /sync — Trigger a connector sync for a specific platform.
   * Called by Cloud Scheduler (daily incremental) or manually for backfill.
   * Auth: service-to-service via Cloud Run identity tokens (checked at API Gateway).
   */
  app.post('/sync', async (req, reply) => {
    const parsed = SyncRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        createErrorResponse('VALIDATION_ERROR', 'Invalid sync request', parsed.error.flatten())
      );
    }

    const { tenantId, platform, dateFrom, dateTo, mode } = parsed.data;

    logger.info('Sync triggered', { tenantId, platform, dateFrom, dateTo, mode });

    // Resolve connector credentials from Secret Manager
    // In production these come from the tenant's stored connector config
    const connectorConfig = await syncJobService.getConnectorConfig(tenantId, platform);
    if (!connectorConfig) {
      return reply.status(404).send(
        createErrorResponse('NOT_FOUND', `No ${platform} connector configured for tenant`)
      );
    }

    // Run async — respond immediately, track via job ID
    const jobId = await syncJobService.enqueueSync({
      tenantId,
      platform,
      dateFrom,
      dateTo,
      mode,
      connectorConfig,
    });

    return reply.status(202).send(
      createSuccessResponse({ jobId, status: 'queued' }, { message: 'Sync enqueued' })
    );
  });

  // ─── Sync Status ─────────────────────────────────────────────────────────

  app.get<{ Params: { jobId: string } }>('/sync/:jobId', async (req, reply) => {
    const job = await syncJobService.getJobStatus(req.params.jobId);
    if (!job) {
      return reply.status(404).send(createErrorResponse('NOT_FOUND', 'Sync job not found'));
    }
    return reply.send(createSuccessResponse(job));
  });

  // ─── Metrics Query ───────────────────────────────────────────────────────

  /**
   * POST /metrics/query — Query aggregated marketing metrics from BigQuery.
   * Used by dashboard to fetch chart data. Partition pruning enforced server-side.
   */
  app.post('/metrics/query', async (req, reply) => {
    const parsed = MetricsQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        createErrorResponse('VALIDATION_ERROR', 'Invalid query params', parsed.error.flatten())
      );
    }

    try {
      const rows = await bqService.queryMetrics(parsed.data);
      return reply.send(
        createSuccessResponse(rows, { rowCount: rows.length })
      );
    } catch (err) {
      logger.error('Metrics query failed', err, { params: parsed.data });
      return reply.status(500).send(
        createErrorResponse('QUERY_ERROR', 'Failed to query metrics')
      );
    }
  });

  // ─── Connector Management ────────────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    '/connectors/:tenantId',
    async (req, reply) => {
      const connectors = await syncJobService.listConnectors(req.params.tenantId);
      return reply.send(createSuccessResponse(connectors));
    }
  );

  // ─── Pub/Sub Push Handler ────────────────────────────────────────────────

  /**
   * POST /pubsub/sync — Pub/Sub push subscription handler.
   * Cloud Scheduler → Pub/Sub → this endpoint for scheduled syncs.
   * Must return 200 quickly or Pub/Sub will retry.
   */
  app.post('/pubsub/sync', async (req, reply) => {
    const message = (req.body as { message?: { data?: string } })?.message;
    if (!message?.data) {
      return reply.status(400).send({ error: 'Missing Pub/Sub message data' });
    }

    try {
      const decoded = Buffer.from(message.data, 'base64').toString('utf-8');
      const payload = JSON.parse(decoded);
      const parsed = SyncRequestSchema.safeParse(payload);

      if (!parsed.success) {
        logger.warn('Invalid Pub/Sub sync message', { payload });
        // Return 200 to prevent retry of malformed messages
        return reply.status(200).send({ status: 'invalid_message_discarded' });
      }

      const { tenantId, platform, dateFrom, dateTo, mode } = parsed.data;
      const connectorConfig = await syncJobService.getConnectorConfig(tenantId, platform);

      if (connectorConfig) {
        await syncJobService.enqueueSync({ tenantId, platform, dateFrom, dateTo, mode, connectorConfig });
      }

      return reply.status(200).send({ status: 'accepted' });
    } catch (err) {
      logger.error('Pub/Sub message processing failed', err);
      // Return 200 to avoid retry storm on persistent errors
      return reply.status(200).send({ status: 'error_discarded' });
    }
  });

  return app;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (process.env['NODE_ENV'] !== 'test') {
  buildApp().then(app => {
    const port = parseInt(process.env['PORT'] ?? '8080');
    app.listen({ port, host: '0.0.0.0' }, (err) => {
      if (err) {
        logger.error('Failed to start marketing-intelligence service', err);
        process.exit(1);
      }
      logger.info('Marketing Intelligence service started', { port });
    });
  });
}
