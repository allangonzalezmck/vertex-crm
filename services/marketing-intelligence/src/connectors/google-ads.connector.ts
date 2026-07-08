/**
 * @file services/marketing-intelligence/src/connectors/google-ads.connector.ts
 * @description Google Ads API v16 connector using GAQL (Google Ads Query Language).
 *
 * Architecture note: We use the REST API directly rather than the Node.js client library
 * because the official gads library is heavy (~200MB) and has poor ESM support.
 * We get OAuth tokens via Google Auth Library (lightweight) and hit the REST endpoints.
 * Trade-off: we own the GAQL query construction, which is manageable given our fixed
 * set of metrics. Alternative: googleapis npm package — rejected due to bundle size and
 * lack of type safety on GAQL responses.
 */

import { GoogleAuth } from 'google-auth-library';
import type { TenantId, UnifiedMetricRow } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GoogleAdsRow {
  campaign: {
    id: string;
    name: string;
    status: string;
  };
  ad_group: {
    id: string;
    name: string;
  };
  ad_group_ad: {
    ad: {
      id: string;
      name: string;
    };
  };
  segments: {
    date: string;
  };
  metrics: {
    impressions: string;
    clicks: string;
    cost_micros: string;
    conversions: string;
    conversions_value: string;
    ctr: string;
    average_cpc: string;
    average_cpm: string;
    cost_per_conversion: string;
    all_conversions_value: string;
    view_through_conversions: string;
    video_views: string;
    average_cpv: string;
  };
  customer: {
    id: string;
    descriptive_name: string;
    currency_code: string;
  };
}

interface GoogleAdsQueryResponse {
  results: GoogleAdsRow[];
  nextPageToken?: string;
  totalResultsCount?: string;
}

export interface GoogleAdsConnectorConfig {
  /** Refresh token from OAuth flow */
  refreshToken: string;
  /** Google Ads developer token */
  developerToken: string;
  /** MCC (manager) customer ID, or single account customer ID */
  customerId: string;
  /** Client ID for OAuth */
  clientId: string;
  /** Client secret for OAuth */
  clientSecret: string;
  /** Login customer ID (MCC) if using sub-accounts */
  loginCustomerId?: string;
}

// ─── Google Ads Connector ───────────────────────────────────────────────────

export class GoogleAdsConnector {
  private readonly baseUrl = 'https://googleads.googleapis.com/v16';
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private readonly config: GoogleAdsConnectorConfig,
    private readonly logger: Logger
  ) {}

  async syncMetrics(
    tenantId: TenantId,
    dateFrom: string,
    dateTo: string
  ): Promise<{ rows: UnifiedMetricRow[]; errors: string[] }> {
    const errors: string[] = [];
    const allRows: UnifiedMetricRow[] = [];

    // Discover accessible customer accounts under MCC
    const customerIds = await this.listAccessibleCustomers();

    for (const customerId of customerIds) {
      try {
        const rows = await this.fetchAdMetrics(tenantId, customerId, dateFrom, dateTo);
        allRows.push(...rows);

        this.logger.info('Google Ads customer sync complete', {
          tenantId,
          customerId,
          rowCount: rows.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Google Ads customer sync failed', err, { customerId, tenantId });
        errors.push(`customer ${customerId}: ${message}`);
      }
    }

    return { rows: allRows, errors };
  }

  /**
   * Fetch ad-level metrics using GAQL.
   * We query at ad_group_ad level to get the finest granularity available.
   * This avoids separate campaign and ad set queries — GAQL joins them in one pass.
   */
  private async fetchAdMetrics(
    tenantId: TenantId,
    customerId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<UnifiedMetricRow[]> {
    const query = buildGaqlQuery(dateFrom, dateTo);
    const allRows: UnifiedMetricRow[] = [];
    let pageToken: string | undefined;

    do {
      const body: Record<string, unknown> = { query, pageSize: 10000 };
      if (pageToken) body['pageToken'] = pageToken;

      const response = await this.request<GoogleAdsQueryResponse>(
        `/customers/${customerId}/googleAds:searchStream`,
        'POST',
        body,
        customerId
      );

      for (const row of response.results ?? []) {
        allRows.push(this.normalizeRow(tenantId, customerId, row));
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    return allRows;
  }

  /**
   * List all accessible non-manager customer accounts.
   * If the configured customerId is already a leaf account, returns it directly.
   */
  private async listAccessibleCustomers(): Promise<string[]> {
    try {
      const response = await this.request<{ resourceNames: string[] }>(
        '/customers:listAccessibleCustomers',
        'GET',
        undefined,
        undefined
      );

      // Extract numeric IDs from resource names like "customers/1234567890"
      return (response.resourceNames ?? []).map(name => name.replace('customers/', ''));
    } catch {
      // Fall back to the configured single customer ID
      return [this.config.customerId];
    }
  }

  normalizeRow(
    tenantId: TenantId,
    customerId: string,
    row: GoogleAdsRow
  ): UnifiedMetricRow {
    const impressions = parseInt(row.metrics.impressions, 10) || 0;
    const clicks = parseInt(row.metrics.clicks, 10) || 0;
    // Google Ads returns spend in micros (millionths of the currency unit)
    const spendUsd = (parseInt(row.metrics.cost_micros, 10) || 0) / 1_000_000;
    const conversions = parseFloat(row.metrics.conversions) || 0;
    const conversionValue = parseFloat(row.metrics.conversions_value) || 0;
    const videoViews = parseInt(row.metrics.video_views, 10) || 0;

    return {
      tenantId,
      date: row.segments.date, // Already in YYYY-MM-DD format
      platform: 'google',
      accountId: customerId,
      campaignId: row.campaign.id,
      campaignName: row.campaign.name,
      adsetId: row.ad_group.id,
      adsetName: row.ad_group.name,
      adId: row.ad_group_ad.ad.id,
      adName: row.ad_group_ad.ad.name,
      impressions,
      clicks,
      spendUsd,
      conversions,
      conversionValueUsd: conversionValue,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpcUsd: clicks > 0 ? spendUsd / clicks : null,
      cpmUsd: impressions > 0 ? (spendUsd / impressions) * 1000 : null,
      cpaUsd: conversions > 0 ? spendUsd / conversions : null,
      roas: spendUsd > 0 ? conversionValue / spendUsd : null,
      reach: null, // Google Ads doesn't expose reach at ad level in basic metrics
      frequency: null,
      videoViews: videoViews > 0 ? videoViews : null,
      extras: {
        campaign_status: row.campaign.status,
        view_through_conversions: parseInt(row.metrics.view_through_conversions, 10) || null,
        average_cpv: parseFloat(row.metrics.average_cpv) || null,
        currency_code: row.customer.currency_code,
      },
      ingestedAt: new Date().toISOString(),
    };
  }

  /**
   * Make an authenticated request to the Google Ads REST API.
   * Handles token refresh transparently.
   */
  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    customerId?: string
  ): Promise<T> {
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'developer-token': this.config.developerToken,
      'Content-Type': 'application/json',
    };

    // Login-customer-id header required when accessing sub-accounts via MCC
    if (this.config.loginCustomerId) {
      headers['login-customer-id'] = this.config.loginCustomerId;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetails: unknown;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = errorText;
      }
      throw new GoogleAdsApiError(
        `Google Ads API error ${response.status}`,
        response.status,
        customerId ?? '',
        errorDetails
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get a valid access token, refreshing if expired.
   * Tokens are cached in-memory (Cloud Run instance lifetime ~5 min is fine here
   * since Google tokens last 1 hour and we refresh with 5-min buffer).
   */
  private async getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    const bufferMs = 5 * 60 * 1000; // Refresh 5 minutes before expiry

    if (this.accessToken && nowMs < this.tokenExpiry - bufferMs) {
      return this.accessToken;
    }

    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth token refresh failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.tokenExpiry = nowMs + data.expires_in * 1000;

    return this.accessToken;
  }
}

// ─── GAQL Query Builder ──────────────────────────────────────────────────────

/**
 * Build the GAQL query for ad-level metrics.
 * GAQL is a SQL-like language — JOINs are implicit based on resource selection.
 * Selecting from ad_group_ad automatically includes campaign and customer resources.
 */
function buildGaqlQuery(dateFrom: string, dateTo: string): string {
  return `
    SELECT
      customer.id,
      customer.descriptive_name,
      customer.currency_code,
      campaign.id,
      campaign.name,
      campaign.status,
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc,
      metrics.average_cpm,
      metrics.cost_per_conversion,
      metrics.view_through_conversions,
      metrics.video_views,
      metrics.average_cpv
    FROM ad_group_ad
    WHERE
      segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY segments.date ASC, campaign.id ASC
  `.trim();
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly customerId: string,
    public readonly details: unknown
  ) {
    super(message);
    this.name = 'GoogleAdsApiError';
  }
}
