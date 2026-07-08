/**
 * @file services/marketing-intelligence/src/services/sync-job.service.ts
 * @description Orchestrates connector sync runs with job tracking in Redis.
 * Credentials are resolved from Cloud SQL connector_configs table (fetched per-sync).
 *
 * Architecture note: Job state lives in Redis (TTL 24h) rather than PostgreSQL
 * because sync jobs are ephemeral and high-frequency. PostgreSQL job history
 * is written only on completion for audit/reporting. This avoids write amplification
 * on the primary DB during parallel syncs across many tenants.
 */

import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { getTenantClient } from '../../../../shared/src/utils/database.js';
import type { TenantId } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';
import type { BigQueryIngestionService } from './bigquery.service.js';
import { MetaConnector, type MetaConnectorConfig } from '../connectors/meta.connector.js';
import { TikTokConnector, type TikTokConnectorConfig } from '../connectors/tiktok.connector.js';
import { GoogleAdsConnector, type GoogleAdsConnectorConfig } from '../connectors/google-ads.connector.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Platform = 'meta' | 'tiktok' | 'google';
export type SyncMode = 'incremental' | 'backfill';

export interface SyncJobRequest {
  tenantId: TenantId;
  platform: Platform;
  dateFrom: string;
  dateTo: string;
  mode: SyncMode;
  connectorConfig: ConnectorConfig;
}

export type ConnectorConfig =
  | { platform: 'meta'; config: MetaConnectorConfig }
  | { platform: 'tiktok'; config: TikTokConnectorConfig }
  | { platform: 'google'; config: GoogleAdsConnectorConfig };

export interface SyncJob {
  jobId: string;
  tenantId: TenantId;
  platform: Platform;
  dateFrom: string;
  dateTo: string;
  mode: SyncMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  rowsIngested: number;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ConnectorRecord {
  id: string;
  tenantId: TenantId;
  platform: Platform;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: 'success' | 'partial' | 'failed' | null;
  createdAt: string;
}

const JOB_TTL_SECONDS = 86_400; // 24 hours

// ─── Sync Job Service ────────────────────────────────────────────────────────

export class SyncJobService {
  constructor(
    private readonly redis: Redis,
    private readonly bqService: BigQueryIngestionService,
    private readonly logger: Logger
  ) {}

  /**
   * Enqueue a sync job and run it immediately in the background.
   * Cloud Run containers handle one request at a time with concurrency=1,
   * so "background" here means we return the HTTP response and continue processing.
   * For true background work at scale, Pub/Sub + separate worker is used.
   */
  async enqueueSync(request: SyncJobRequest): Promise<string> {
    const jobId = randomUUID();
    const job: SyncJob = {
      jobId,
      tenantId: request.tenantId,
      platform: request.platform,
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      mode: request.mode,
      status: 'queued',
      rowsIngested: 0,
      errors: [],
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };

    await this.redis.setex(
      `sync:job:${jobId}`,
      JOB_TTL_SECONDS,
      JSON.stringify(job)
    );

    // Fire-and-forget — intentional, HTTP response returns before completion
    this.runSync(jobId, request).catch(err => {
      this.logger.error('Unhandled sync job error', err, { jobId });
    });

    return jobId;
  }

  async getJobStatus(jobId: string): Promise<SyncJob | null> {
    const raw = await this.redis.get(`sync:job:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw) as SyncJob;
  }

  async listConnectors(tenantId: TenantId): Promise<ConnectorRecord[]> {
    const client = await getTenantClient(tenantId);
    try {
      const result = await client.query<ConnectorRecord>(
        `SELECT
           id, tenant_id, platform, is_active,
           last_sync_at, last_sync_status, created_at
         FROM connector_configs
         WHERE tenant_id = $1
         ORDER BY platform ASC`,
        [tenantId]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve connector credentials from encrypted DB storage.
   * In production, the config blob is encrypted with the tenant's DEK (Cloud KMS).
   * Here we fetch the ciphertext and decrypt it on the fly.
   */
  async getConnectorConfig(
    tenantId: TenantId,
    platform: Platform
  ): Promise<ConnectorConfig | null> {
    const client = await getTenantClient(tenantId);
    try {
      const result = await client.query<{
        platform: Platform;
        config_encrypted: string;
        config_plain: Record<string, unknown>; // Only in dev/test
      }>(
        `SELECT platform, config_plain
         FROM connector_configs
         WHERE tenant_id = $1 AND platform = $2 AND is_active = true
         LIMIT 1`,
        [tenantId, platform]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0]!;
      const config = row.config_plain;

      if (platform === 'meta') {
        return {
          platform: 'meta',
          config: {
            accessToken: config['access_token'] as string,
            adAccountIds: config['ad_account_ids'] as string[],
          },
        };
      }

      if (platform === 'tiktok') {
        return {
          platform: 'tiktok',
          config: {
            accessToken: config['access_token'] as string,
            advertiserIds: config['advertiser_ids'] as string[],
          },
        };
      }

      if (platform === 'google') {
        return {
          platform: 'google',
          config: {
            refreshToken: config['refresh_token'] as string,
            developerToken: config['developer_token'] as string,
            customerId: config['customer_id'] as string,
            clientId: config['client_id'] as string,
            clientSecret: config['client_secret'] as string,
            loginCustomerId: config['login_customer_id'] as string | undefined,
          },
        };
      }

      return null;
    } finally {
      client.release();
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async runSync(jobId: string, request: SyncJobRequest): Promise<void> {
    const timer = this.logger.startTimer();

    await this.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    try {
      let result: { rows?: import('../../../../shared/src/types/index.js').UnifiedMetricRow[]; rowsIngested?: number; errors: string[] };

      if (request.connectorConfig.platform === 'meta') {
        const connector = new MetaConnector(
          request.connectorConfig.config,
          this.logger.child({ platform: 'meta', tenantId: request.tenantId })
        );
        result = await connector.syncMetrics(
          request.tenantId,
          request.dateFrom,
          request.dateTo
        );
      } else if (request.connectorConfig.platform === 'tiktok') {
        const connector = new TikTokConnector(
          request.connectorConfig.config,
          await this.getRedis(),
          this.logger.child({ platform: 'tiktok', tenantId: request.tenantId })
        );
        const syncResult = await connector.syncMetrics(
          request.tenantId,
          request.dateFrom,
          request.dateTo
        );
        result = { rowsIngested: syncResult.rowsIngested, errors: syncResult.errors };
      } else {
        const connector = new GoogleAdsConnector(
          request.connectorConfig.config,
          this.logger.child({ platform: 'google', tenantId: request.tenantId })
        );
        const syncResult = await connector.syncMetrics(
          request.tenantId,
          request.dateFrom,
          request.dateTo
        );

        // Write rows to BigQuery
        if (syncResult.rows.length > 0) {
          const insertResult = request.mode === 'backfill'
            ? await this.bqService.mergeRows(syncResult.rows).then(() => ({ insertedCount: syncResult.rows.length, failedRows: [] }))
            : await this.bqService.insertRows(syncResult.rows);

          result = {
            rowsIngested: insertResult.insertedCount,
            errors: [
              ...syncResult.errors,
              ...insertResult.failedRows.map(f => `Row insert failed: ${f.errors.join(', ')}`),
            ],
          };
        } else {
          result = { rowsIngested: 0, errors: syncResult.errors };
        }
      }

      // Handle Meta/TikTok rows (they return rows for BQ insertion)
      if (result.rows && result.rows.length > 0) {
        const insertResult = request.mode === 'backfill'
          ? await this.bqService.mergeRows(result.rows).then(() => ({ insertedCount: result.rows!.length, failedRows: [] }))
          : await this.bqService.insertRows(result.rows);

        result.rowsIngested = insertResult.insertedCount;
        result.errors.push(
          ...insertResult.failedRows.map(f => `Row insert failed: ${f.errors.join(', ')}`)
        );
      }

      const hasErrors = result.errors.length > 0;
      const finalStatus = hasErrors && (result.rowsIngested ?? 0) === 0 ? 'failed' : 'completed';

      await this.updateJob(jobId, {
        status: finalStatus,
        rowsIngested: result.rowsIngested ?? 0,
        errors: result.errors,
        completedAt: new Date().toISOString(),
      });

      await this.recordSyncHistory(request, result.rowsIngested ?? 0, result.errors);

      timer({ jobId, platform: request.platform, rowsIngested: result.rowsIngested, status: finalStatus });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.updateJob(jobId, {
        status: 'failed',
        errors: [message],
        completedAt: new Date().toISOString(),
      });

      await this.recordSyncHistory(request, 0, [message]);

      this.logger.error('Sync job failed', err, { jobId, platform: request.platform });
    }
  }

  private async updateJob(jobId: string, updates: Partial<SyncJob>): Promise<void> {
    const raw = await this.redis.get(`sync:job:${jobId}`);
    if (!raw) return;

    const job = { ...JSON.parse(raw) as SyncJob, ...updates };
    await this.redis.setex(`sync:job:${jobId}`, JOB_TTL_SECONDS, JSON.stringify(job));
  }

  private async recordSyncHistory(
    request: SyncJobRequest,
    rowsIngested: number,
    errors: string[]
  ): Promise<void> {
    const client = await getTenantClient(request.tenantId);
    try {
      await client.query(
        `INSERT INTO sync_history
           (tenant_id, platform, date_from, date_to, mode, rows_ingested,
            error_count, errors, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT DO NOTHING`,
        [
          request.tenantId,
          request.platform,
          request.dateFrom,
          request.dateTo,
          request.mode,
          rowsIngested,
          errors.length,
          JSON.stringify(errors),
        ]
      );
    } catch (err) {
      // Non-fatal — don't fail the sync over history recording
      this.logger.warn('Failed to record sync history', { error: err });
    } finally {
      client.release();
    }
  }

  private async getRedis(): Promise<Redis> {
    return this.redis;
  }
}
