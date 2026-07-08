/**
 * @file services/marketing-intelligence/src/connectors/meta.connector.ts
 * @description META Marketing API v19 connector.
 * Handles OAuth token management, incremental sync, rate limiting, and normalization.
 *
 * Architecture note: Connectors are stateless. State (tokens, sync watermarks)
 * lives in Cloud SQL and Secret Manager. This class can be instantiated per
 * request or per Pub/Sub message without issues.
 */

import type { TenantId } from '../../../../shared/src/types/index.js';
import type { UnifiedMetricRow } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MetaInsightsResponse {
  data: MetaInsightRow[];
  paging?: {
    cursors?: { after: string };
    next?: string;
  };
}

interface MetaInsightRow {
  campaign_id: string;
  campaign_name: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  impressions: string;
  clicks: string;
  spend: string;
  reach?: string;
  frequency?: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
  video_avg_time_watched_actions?: Array<{ action_type: string; value: string }>;
  date_start: string;
  date_stop: string;
  account_id: string;
}

export interface MetaConnectorConfig {
  accessToken: string;
  accountIds: string[];
  apiVersion?: string;
}

interface SyncResult {
  rowsIngested: number;
  errors: Array<{ accountId: string; error: string }>;
  dateRange: { from: string; to: string };
}

// ─── Rate Limiter (Token Bucket) ─────────────────────────────────────────────

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerSecond: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async consume(count = 1): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRatePerSecond
    );
    this.lastRefill = now;

    if (this.tokens < count) {
      const waitMs = ((count - this.tokens) / this.refillRatePerSecond) * 1000;
      await sleep(waitMs);
      this.tokens = 0;
    } else {
      this.tokens -= count;
    }
  }
}

// ─── META Connector ───────────────────────────────────────────────────────────

export class MetaConnector {
  private readonly baseUrl: string;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly maxRetries = 3;

  constructor(
    private readonly config: MetaConnectorConfig,
    private readonly logger: Logger
  ) {
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion ?? 'v19.0'}`;
    // 200 calls/hour = ~0.055/sec. Use 0.05 to be conservative.
    this.rateLimiter = new TokenBucketRateLimiter(50, 0.05);
  }

  /**
   * Perform incremental sync for a date range across all configured accounts.
   * Uses the batch endpoint (50 requests per batch) to minimize rate limit usage.
   */
  async syncMetrics(
    tenantId: TenantId,
    dateFrom: string,
    dateTo: string
  ): Promise<SyncResult> {
    const result: SyncResult = {
      rowsIngested: 0,
      errors: [],
      dateRange: { from: dateFrom, to: dateTo },
    };

    // Process accounts in batches of 50 (Meta batch limit)
    const batches = chunk(this.config.accountIds, 50);

    for (const accountBatch of batches) {
      const batchResults = await this.fetchBatch(accountBatch, dateFrom, dateTo);

      for (const { accountId, data, error } of batchResults) {
        if (error) {
          this.logger.error('Meta batch request failed', undefined, { accountId, error });
          result.errors.push({ accountId, error });
          continue;
        }

        // Collect all pages for this account
        const allRows = [...(data ?? [])];
        let paginationCursor = data?.slice(-1)[0] ? undefined : undefined; // handled in fetchAllPages

        const rows = await this.fetchAllPages(accountId, dateFrom, dateTo);
        allRows.push(...rows);

        const normalized = allRows.map(row => this.normalizeRow(tenantId, row));
        result.rowsIngested += normalized.length;

        // Caller (ingestion worker) handles BigQuery write
        this.logger.info('Account sync complete', {
          tenantId,
          accountId,
          rowCount: normalized.length,
          dateFrom,
          dateTo,
        });
      }
    }

    return result;
  }

  /**
   * Fetch all rows for a single account, handling cursor-based pagination.
   */
  async fetchAllPages(
    accountId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<MetaInsightRow[]> {
    const allRows: MetaInsightRow[] = [];
    let afterCursor: string | undefined;

    do {
      await this.rateLimiter.consume();

      const params = new URLSearchParams({
        fields: INSIGHTS_FIELDS.join(','),
        level: 'ad',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        time_increment: '1',
        limit: '500',
        access_token: this.config.accessToken,
      });

      if (afterCursor) {
        params.set('after', afterCursor);
      }

      const response = await this.fetchWithRetry(
        `${this.baseUrl}/act_${accountId}/insights?${params.toString()}`
      );

      const json = await response.json() as MetaInsightsResponse;

      if ((json as { error?: { message: string; code: number } }).error) {
        const apiError = (json as { error: { message: string; code: number } }).error;
        throw new MetaApiError(apiError.message, apiError.code, accountId);
      }

      allRows.push(...(json.data ?? []));
      afterCursor = json.paging?.cursors?.after;

      // Stop if no next page or we've hit a reasonable limit
    } while (afterCursor && allRows.length < 100_000);

    return allRows;
  }

  /**
   * Batch endpoint: send up to 50 insight requests in a single HTTP call.
   * Returns 200 even for per-request errors — check each response individually.
   */
  private async fetchBatch(
    accountIds: string[],
    dateFrom: string,
    dateTo: string
  ): Promise<Array<{ accountId: string; data: MetaInsightRow[] | null; error: string | null }>> {
    await this.rateLimiter.consume(); // batch counts as 1 call

    const batch = accountIds.map(accountId => ({
      method: 'GET',
      relative_url: `act_${accountId}/insights?fields=${INSIGHTS_FIELDS.join(',')}&level=ad&time_range=${JSON.stringify({ since: dateFrom, until: dateTo })}&time_increment=1&limit=100`,
    }));

    const response = await this.fetchWithRetry(`${this.baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch,
        access_token: this.config.accessToken,
      }),
    });

    const batchResponse = await response.json() as Array<{
      code: number;
      body: string;
    }>;

    return batchResponse.map((item, index) => {
      const accountId = accountIds[index] ?? '';
      if (item.code !== 200) {
        let errorMessage = `HTTP ${item.code}`;
        try {
          const parsed = JSON.parse(item.body) as { error?: { message: string } };
          errorMessage = parsed.error?.message ?? errorMessage;
        } catch {
          // Body not parseable
        }
        return { accountId, data: null, error: errorMessage };
      }

      try {
        const parsed = JSON.parse(item.body) as MetaInsightsResponse;
        return { accountId, data: parsed.data ?? [], error: null };
      } catch {
        return { accountId, data: null, error: 'Failed to parse response body' };
      }
    });
  }

  /**
   * Normalize a META API row to the unified platform schema.
   * All numeric fields are parsed from strings. Division-by-zero protected.
   */
  normalizeRow(tenantId: TenantId, row: MetaInsightRow): UnifiedMetricRow {
    const impressions = parseInt(row.impressions ?? '0', 10);
    const clicks = parseInt(row.clicks ?? '0', 10);
    const spendUsd = parseFloat(row.spend ?? '0');
    const reach = row.reach ? parseInt(row.reach, 10) : null;

    // Extract conversion actions from the actions array
    const conversionActions = row.actions?.filter(
      a => ['lead', 'purchase', 'complete_registration', 'offsite_conversion.fb_pixel_purchase'].includes(a.action_type)
    ) ?? [];
    const conversions = conversionActions.reduce((sum, a) => sum + parseFloat(a.value), 0);

    const conversionValueActions = row.action_values?.filter(
      a => ['purchase', 'offsite_conversion.fb_pixel_purchase'].includes(a.action_type)
    ) ?? [];
    const conversionValueUsd = conversionValueActions.reduce((sum, a) => sum + parseFloat(a.value), 0);

    const leadCpa = row.cost_per_action_type?.find(a => a.action_type === 'lead');
    const roas = row.purchase_roas?.[0];
    const videoViews = row.video_avg_time_watched_actions?.[0]?.value
      ? parseInt(row.video_avg_time_watched_actions[0]!.value, 10)
      : null;

    return {
      tenantId,
      date: row.date_start,
      platform: 'meta',
      accountId: row.account_id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? '',
      adsetId: row.adset_id ?? null,
      adsetName: row.adset_name ?? null,
      adId: row.ad_id ?? null,
      adName: row.ad_name ?? null,
      impressions,
      clicks,
      spendUsd,
      conversions,
      conversionValueUsd,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpcUsd: clicks > 0 ? spendUsd / clicks : null,
      cpmUsd: impressions > 0 ? (spendUsd / impressions) * 1000 : null,
      cpaUsd: leadCpa ? parseFloat(leadCpa.value) : (conversions > 0 ? spendUsd / conversions : null),
      roas: roas ? parseFloat(roas.value) : (spendUsd > 0 && conversionValueUsd > 0 ? conversionValueUsd / spendUsd : null),
      reach,
      frequency: reach && reach > 0 ? impressions / reach : null,
      videoViews,
      extras: {
        // Store Meta-specific fields for forward compatibility
        platform_ctr: row.ctr ? parseFloat(row.ctr) : null,
        platform_cpc: row.cpc ? parseFloat(row.cpc) : null,
        platform_cpm: row.cpm ? parseFloat(row.cpm) : null,
      },
      ingestedAt: new Date().toISOString(),
    };
  }

  private async fetchWithRetry(
    url: string,
    options?: RequestInit,
    attempt = 0
  ): Promise<Response> {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000), // 30s timeout
      });

      // Handle rate limiting
      if (response.status === 429 || response.status === 503) {
        if (attempt >= this.maxRetries) {
          throw new MetaApiError('Rate limit exceeded after retries', 429, '');
        }
        const backoffMs = Math.min(30_000 * Math.pow(2, attempt), 120_000);
        this.logger.warn('Rate limited, backing off', { attempt, backoffMs });
        await sleep(backoffMs);
        return this.fetchWithRetry(url, options, attempt + 1);
      }

      return response;
    } catch (err) {
      if (attempt < this.maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        this.logger.warn('Request failed, retrying', { attempt, backoffMs, error: String(err) });
        await sleep(backoffMs);
        return this.fetchWithRetry(url, options, attempt + 1);
      }
      throw err;
    }
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INSIGHTS_FIELDS = [
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'impressions',
  'clicks',
  'spend',
  'reach',
  'frequency',
  'cpc',
  'cpm',
  'ctr',
  'actions',
  'action_values',
  'cost_per_action_type',
  'purchase_roas',
  'video_avg_time_watched_actions',
  'account_id',
];

// ─── Errors ───────────────────────────────────────────────────────────────────

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly accountId: string
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
