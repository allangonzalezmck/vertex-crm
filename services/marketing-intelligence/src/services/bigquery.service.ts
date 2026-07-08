/**
 * @file services/marketing-intelligence/src/services/bigquery.service.ts
 * @description BigQuery ingestion service for unified marketing metrics.
 * Uses streaming inserts for real-time availability, MERGE for deduplication.
 *
 * Architecture note: We use streaming inserts (not load jobs) because:
 * 1. Metrics need to be queryable within seconds for near-real-time dashboards
 * 2. Our row sizes (~500 bytes) and volumes (~10M rows/day at scale) fit BQ streaming limits
 * 3. Load jobs have 10-minute minimum latency which breaks dashboard UX
 * Trade-off: Streaming inserts cost ~$0.01/200MB vs free for load jobs.
 * At 10M rows/day × 500 bytes = 5GB/day → ~$0.25/day → acceptable.
 */

import { BigQuery, type InsertRowsOptions } from '@google-cloud/bigquery';
import type { UnifiedMetricRow } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';

const DATASET_ID = 'vertex_analytics';
const TABLE_ID = 'marketing_metrics';
const MAX_ROWS_PER_INSERT = 500; // BigQuery streaming limit recommendation

export class BigQueryIngestionService {
  private readonly bq: BigQuery;
  private readonly table: ReturnType<BigQuery['dataset']>['table'] extends (id: string) => infer R ? R : never;

  constructor(
    private readonly projectId: string,
    private readonly logger: Logger
  ) {
    this.bq = new BigQuery({ projectId });
    this.table = this.bq.dataset(DATASET_ID).table(TABLE_ID);
  }

  /**
   * Stream rows to BigQuery using the insertAll API.
   * Rows are batched to stay under API limits.
   * On partial failure, failed rows are logged and returned for retry.
   */
  async insertRows(rows: UnifiedMetricRow[]): Promise<{
    insertedCount: number;
    failedRows: Array<{ row: UnifiedMetricRow; errors: string[] }>;
  }> {
    if (rows.length === 0) {
      return { insertedCount: 0, failedRows: [] };
    }

    const batches = chunk(rows, MAX_ROWS_PER_INSERT);
    let insertedCount = 0;
    const failedRows: Array<{ row: UnifiedMetricRow; errors: string[] }> = [];

    for (const batch of batches) {
      const bqRows = batch.map(row => ({
        // insertId for deduplication (same day + platform + ad = same row)
        // BigQuery deduplicates within a 1-minute window using insertId
        insertId: `${row.tenantId}:${row.date}:${row.platform}:${row.adId ?? row.adsetId ?? row.campaignId}`,
        json: this.toBigQueryRow(row),
      }));

      try {
        const options: InsertRowsOptions = {
          skipInvalidRows: false,
          ignoreUnknownValues: false,
          raw: true, // Use raw format with insertId
        };

        await this.table.insert(bqRows, options);
        insertedCount += batch.length;

        this.logger.info('BigQuery batch inserted', {
          batchSize: batch.length,
          platform: batch[0]?.platform,
          tenantId: batch[0]?.tenantId,
        });
      } catch (err) {
        // BigQuery insertAll errors have partial failure information
        if (isInsertErrors(err)) {
          const errors = err.errors ?? [];
          for (const insertError of errors) {
            const rowIndex = insertError.index ?? 0;
            const originalRow = batch[rowIndex];
            if (originalRow) {
              failedRows.push({
                row: originalRow,
                errors: insertError.errors?.map(e => `${e.reason}: ${e.message}`) ?? [],
              });
            }
          }
          insertedCount += batch.length - failedRows.length;
          this.logger.error('BigQuery partial insert failure', undefined, {
            batchSize: batch.length,
            failedCount: failedRows.length,
          });
        } else {
          // Total batch failure
          this.logger.error('BigQuery batch insert failed', err, {
            batchSize: batch.length,
          });
          for (const row of batch) {
            failedRows.push({
              row,
              errors: [err instanceof Error ? err.message : String(err)],
            });
          }
        }
      }
    }

    return { insertedCount, failedRows };
  }

  /**
   * MERGE-based upsert for backfill operations.
   * Used when re-syncing historical data that may already exist.
   * More expensive than streaming insert — use only for backfill jobs.
   */
  async mergeRows(rows: UnifiedMetricRow[]): Promise<void> {
    if (rows.length === 0) return;

    // Write to a temp table, then MERGE into marketing_metrics
    const tempTableId = `marketing_metrics_tmp_${Date.now()}`;
    const tempTable = this.bq.dataset(DATASET_ID).table(tempTableId);

    try {
      // Create temp table with same schema
      await tempTable.create({
        schema: MARKETING_METRICS_SCHEMA,
        expirationTime: Date.now() + 3600000, // expire in 1 hour
      });

      // Insert into temp table
      const bqRows = rows.map(row => ({ json: this.toBigQueryRow(row) }));
      await tempTable.insert(bqRows, { raw: true });

      // MERGE into target table
      const mergeQuery = `
        MERGE \`${this.projectId}.${DATASET_ID}.${TABLE_ID}\` T
        USING \`${this.projectId}.${DATASET_ID}.${tempTableId}\` S
        ON T.tenant_id = S.tenant_id
          AND T.date = S.date
          AND T.platform = S.platform
          AND T.ad_id = S.ad_id
          AND T.adset_id = S.adset_id
          AND T.campaign_id = S.campaign_id
          AND T.account_id = S.account_id
        WHEN MATCHED THEN UPDATE SET
          T.impressions = S.impressions,
          T.clicks = S.clicks,
          T.spend_usd = S.spend_usd,
          T.conversions = S.conversions,
          T.conversion_value_usd = S.conversion_value_usd,
          T.ctr = S.ctr,
          T.cpc_usd = S.cpc_usd,
          T.cpm_usd = S.cpm_usd,
          T.cpa_usd = S.cpa_usd,
          T.roas = S.roas,
          T.reach = S.reach,
          T.frequency = S.frequency,
          T.video_views = S.video_views,
          T.extras = S.extras,
          T.ingested_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT ROW
      `;

      const [job] = await this.bq.createQueryJob({ query: mergeQuery });
      await job.getQueryResults();

      this.logger.info('BigQuery MERGE complete', { rowCount: rows.length });
    } finally {
      // Clean up temp table
      try {
        await tempTable.delete();
      } catch {
        // Non-fatal — table will expire automatically
      }
    }
  }

  /**
   * Query metrics for dashboard with partition pruning enforced.
   * Returns aggregated data for the specified date range, platform, and tenant.
   */
  async queryMetrics(params: {
    tenantId: string;
    dateFrom: string;
    dateTo: string;
    platforms?: string[];
    groupBy: string[];
    metrics: string[];
  }): Promise<Record<string, unknown>[]> {
    const allowedGroupBy = new Set([
      'date', 'platform', 'campaign_id', 'campaign_name',
      'adset_id', 'adset_name', 'ad_id', 'ad_name',
    ]);

    const allowedMetrics = new Set([
      'impressions', 'clicks', 'spend_usd', 'conversions', 'conversion_value_usd',
      'ctr', 'cpc_usd', 'cpm_usd', 'cpa_usd', 'roas', 'reach', 'video_views',
    ]);

    // Allowlist validation to prevent SQL injection in BigQuery queries
    const safeGroupBy = params.groupBy.filter(g => allowedGroupBy.has(g));
    const safeMetrics = params.metrics.filter(m => allowedMetrics.has(m));

    if (safeGroupBy.length === 0 || safeMetrics.length === 0) {
      throw new Error('Invalid groupBy or metrics fields');
    }

    const metricAggregations = safeMetrics.map(m => {
      // Rate metrics use weighted average, counts use SUM
      const rateMetrics = new Set(['ctr', 'cpc_usd', 'cpm_usd', 'cpa_usd', 'roas', 'frequency']);
      if (rateMetrics.has(m)) {
        // Recalculate rates from base metrics rather than averaging rates
        const rateFormulas: Record<string, string> = {
          ctr: 'SAFE_DIVIDE(SUM(clicks), SUM(impressions)) * 100',
          cpc_usd: 'SAFE_DIVIDE(SUM(spend_usd), SUM(clicks))',
          cpm_usd: 'SAFE_DIVIDE(SUM(spend_usd), SUM(impressions)) * 1000',
          cpa_usd: 'SAFE_DIVIDE(SUM(spend_usd), SUM(conversions))',
          roas: 'SAFE_DIVIDE(SUM(conversion_value_usd), SUM(spend_usd))',
          frequency: 'SAFE_DIVIDE(SUM(impressions), SUM(reach))',
        };
        return `${rateFormulas[m] ?? `AVG(${m})`} AS ${m}`;
      }
      return `SUM(${m}) AS ${m}`;
    });

    const platformFilter = params.platforms && params.platforms.length > 0
      ? `AND platform IN (${params.platforms.map(p => `'${p.replace(/'/g, '')}'`).join(', ')})`
      : '';

    const query = `
      SELECT
        ${safeGroupBy.join(', ')},
        ${metricAggregations.join(',\n        ')}
      FROM \`${this.projectId}.${DATASET_ID}.${TABLE_ID}\`
      WHERE
        tenant_id = @tenantId
        AND date BETWEEN @dateFrom AND @dateTo
        ${platformFilter}
      GROUP BY ${safeGroupBy.join(', ')}
      ORDER BY ${safeGroupBy.includes('date') ? 'date' : safeGroupBy[0]} ASC
      LIMIT 10000
    `;

    const [rows] = await this.bq.query({
      query,
      params: {
        tenantId: params.tenantId,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      },
      location: 'US',
    });

    return rows;
  }

  /**
   * Convert UnifiedMetricRow to BigQuery row format.
   * BigQuery expects specific types — no JavaScript objects directly.
   */
  private toBigQueryRow(row: UnifiedMetricRow): Record<string, unknown> {
    return {
      tenant_id: row.tenantId,
      date: row.date,
      platform: row.platform,
      account_id: row.accountId,
      campaign_id: row.campaignId,
      campaign_name: row.campaignName,
      adset_id: row.adsetId,
      adset_name: row.adsetName,
      ad_id: row.adId,
      ad_name: row.adName,
      impressions: row.impressions,
      clicks: row.clicks,
      spend_usd: row.spendUsd,
      conversions: row.conversions,
      conversion_value_usd: row.conversionValueUsd,
      ctr: row.ctr,
      cpc_usd: row.cpcUsd,
      cpm_usd: row.cpmUsd,
      cpa_usd: row.cpaUsd,
      roas: row.roas,
      reach: row.reach,
      frequency: row.frequency,
      video_views: row.videoViews,
      extras: JSON.stringify(row.extras),
      ingested_at: row.ingestedAt,
    };
  }
}

// ─── BigQuery Schema ─────────────────────────────────────────────────────────

const MARKETING_METRICS_SCHEMA = [
  { name: 'tenant_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'platform', type: 'STRING', mode: 'REQUIRED' },
  { name: 'account_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'campaign_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'campaign_name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'adset_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'adset_name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ad_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ad_name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'impressions', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'clicks', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'spend_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'conversions', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'conversion_value_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'ctr', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'cpc_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'cpm_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'cpa_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'roas', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'reach', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'frequency', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'video_views', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'extras', type: 'JSON', mode: 'NULLABLE' },
  { name: 'anomaly_score', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'fatigue_score', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'pacing_alert', type: 'BOOL', mode: 'NULLABLE' },
  { name: 'ingested_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function isInsertErrors(err: unknown): err is {
  errors: Array<{ index: number; errors: Array<{ reason: string; message: string }> }>;
} {
  return (
    typeof err === 'object' &&
    err !== null &&
    'errors' in err &&
    Array.isArray((err as { errors: unknown }).errors)
  );
}
