# Vertex CRM — Marketing API Contracts
## Doc 2: Channel Connector Specifications

---

## META (Facebook + Instagram) — Marketing API v19+

### Auth Flow
```
Type: OAuth 2.0 (System User token preferred for stability)
Scopes: ads_read, ads_management, business_management, read_insights
Token storage: Secret Manager as vertex/tenant/{id}/meta/access-token
Refresh: Long-lived tokens (60 days), auto-refresh via cron 7 days before expiry
App-level: App ID + App Secret for server-side validation
```

### Rate Limits
```
Per-token: 200 calls/hour (Marketing API tier)
Batch endpoint: /v19.0/ → up to 50 requests per batch call
Throttle strategy: Token bucket, refill 200/3600 = 0.055 req/sec
On 429: Exponential backoff (30s, 60s, 120s), then DLQ
Headers to watch: X-Business-Use-Case-Usage, X-App-Usage
```

### Key Endpoints

#### Campaign Insights (Ad Level)
```http
GET /v19.0/act_{account_id}/insights
  ?fields=campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,
          impressions,clicks,spend,reach,frequency,
          cpc,cpm,ctr,actions,action_values,cost_per_action_type,
          purchase_roas,video_avg_time_watched_actions,video_p25_watched_actions,
          video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions
  &level=ad
  &time_range={"since":"2024-01-01","until":"2024-01-07"}
  &time_increment=1
  &limit=500
  &after={cursor}  (pagination)
```

#### Batch Endpoint
```json
POST /v19.0/
{
  "batch": [
    {
      "method": "GET",
      "relative_url": "act_123/insights?fields=impressions,clicks,spend&level=ad&date_preset=yesterday"
    },
    {
      "method": "GET",
      "relative_url": "act_456/insights?fields=impressions,clicks,spend&level=ad&date_preset=yesterday"
    }
  ],
  "access_token": "{token}"
}
```

### Field Normalization Map
```typescript
// Meta API response → Unified Schema
const META_FIELD_MAP = {
  impressions: 'impressions',                          // string → number
  clicks: 'clicks',                                    // string → number
  spend: 'spend_usd',                                  // string → number (already USD)
  reach: 'reach',                                      // string → number
  frequency: 'frequency',                              // string → number
  cpc: 'cpc_usd',                                      // string → number
  cpm: 'cpm_usd',                                      // string → number
  ctr: 'ctr',                                          // string → number (percentage, /100)
  // Actions array: find action_type = 'lead' or 'purchase'
  'actions[lead].value': 'conversions',
  'action_values[purchase].value': 'conversion_value_usd',
  'cost_per_action_type[lead].value': 'cpa_usd',
  'purchase_roas[0].value': 'roas',
  'video_avg_time_watched_actions[0].value': 'video_views',  // proxy
} as const;
```

### Webhook Setup (Real-time Updates)
```
App Webhooks → subscribe to: ads_rules (budget changes), pages (engagement)
Verify token: stored in Secret Manager, validated on each webhook delivery
```

---

## TikTok for Business — Marketing API

### Auth Flow
```
Type: OAuth 2.0
Base URL: https://business-api.tiktok.com/open_api/v1.3/
Scopes: read_campaign, read_ad_report, click_attribution
Token storage: vertex/tenant/{id}/tiktok/access-token
Sandbox: Available at https://sandbox-ads.tiktok.com (use for dev/staging)
App ID + Secret: vertex/tiktok/app-{id}
```

### Rate Limits
```
Per-advertiser: 10 QPS (queries per second)
Daily limit: 100,000 API calls per advertiser
Throttle strategy: Redis sliding window counter per advertiser_id
On throttle: Queue to Pub/Sub with 10s delay, process sequentially
```

### Key Endpoints

#### Integrated Report (Ad Level)
```http
GET /open_api/v1.3/report/integrated/get/
  ?advertiser_id={advertiser_id}
  &report_type=BASIC
  &dimensions=["ad_id","stat_time_day"]
  &metrics=["spend","impressions","clicks","ctr","cpc","cpm",
            "conversions","cost_per_conversion","conversion_rate",
            "video_play_actions","video_watched_2s","video_watched_6s",
            "video_views_p25","video_views_p50","video_views_p75","video_views_p100",
            "reach","frequency"]
  &start_date=2024-01-01
  &end_date=2024-01-07
  &page=1
  &page_size=1000
  &filtering=[{"field_name":"status","filter_type":"IN","filter_value":"[\"STATUS_ENABLE\",\"STATUS_DISABLE\"]"}]
```

#### Campaign List
```http
GET /open_api/v1.3/campaign/get/
  ?advertiser_id={advertiser_id}
  &fields=["campaign_id","campaign_name","status","budget","budget_mode"]
  &page_size=1000
```

### Field Normalization Map
```typescript
const TIKTOK_FIELD_MAP = {
  stat_time_day: 'date',
  spend: 'spend_usd',                     // Already USD
  impressions: 'impressions',
  clicks: 'clicks',
  ctr: 'ctr',                             // Already percentage
  cpc: 'cpc_usd',
  cpm: 'cpm_usd',
  conversions: 'conversions',
  cost_per_conversion: 'cpa_usd',
  video_play_actions: 'video_views',
  video_watched_2s: 'video_2s_views',     // TikTok-specific, store in extras JSON
  video_watched_6s: 'video_6s_views',     // TikTok-specific, store in extras JSON
  reach: 'reach',
  frequency: 'frequency',
  // ROAS: calculated post-normalization if conversion_value available
} as const;
```

### Business Messaging (AI Sales Agent)
```
Endpoint: TikTok Business Messaging API
Webhook events: message (DM received), conversation_create
Reply endpoint: POST /open_api/v1.3/customer_service/message/send/
Restrictions:
  - Only respond to user-initiated DMs
  - 7-day messaging window from last user message
  - Supported message types: text, image, product_card
```

---

## YouTube / Google Ads — API v16

### Auth Flow
```
Type: OAuth 2.0 + Developer Token (required for all calls)
Client library: google-ads-api (Node.js) or google-ads (Python)
Scopes: https://www.googleapis.com/auth/adwords
Developer token: vertex/google-ads/developer-token (approved for basic access)
Manager account (MCC): vertex/google-ads/mcc-customer-id
Refresh token: vertex/tenant/{id}/google-ads/refresh-token
```

### Rate Limits
```
Developer token (basic access): 15,000 requests/day
Per-account: No hard QPS limit, but server-streaming preferred
Strategy: GoogleAdsService.SearchStream for large reports (avoids pagination limits)
Report: Use GAQL (Google Ads Query Language) not legacy reports
```

### Key GAQL Queries

#### Campaign Performance
```sql
-- Ad-level performance
SELECT
  ad_group_ad.ad.id,
  ad_group_ad.ad.name,
  ad_group.id,
  ad_group.name,
  campaign.id,
  campaign.name,
  segments.date,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  metrics.video_views,
  metrics.view_through_conversions,
  metrics.ctr,
  metrics.average_cpc,
  metrics.average_cpm,
  metrics.cost_per_conversion
FROM ad_group_ad
WHERE segments.date BETWEEN '2024-01-01' AND '2024-01-07'
  AND campaign.status = 'ENABLED'
  AND ad_group.status = 'ENABLED'
ORDER BY segments.date DESC
LIMIT 10000
```

#### Budget Info
```sql
SELECT
  campaign.id,
  campaign.name,
  campaign_budget.amount_micros,
  campaign_budget.period,
  campaign.status
FROM campaign
WHERE campaign.status != 'REMOVED'
```

### Field Normalization Map
```typescript
const GOOGLE_ADS_FIELD_MAP = {
  'segments.date': 'date',
  'campaign.id': 'campaign_id',
  'campaign.name': 'campaign_name',
  'ad_group.id': 'adset_id',
  'ad_group.name': 'adset_name',
  'ad_group_ad.ad.id': 'ad_id',
  'ad_group_ad.ad.name': 'ad_name',
  'metrics.impressions': 'impressions',
  'metrics.clicks': 'clicks',
  'metrics.cost_micros': 'spend_usd',     // divide by 1,000,000
  'metrics.conversions': 'conversions',
  'metrics.conversions_value': 'conversion_value_usd',
  'metrics.video_views': 'video_views',
  'metrics.ctr': 'ctr',                   // Already decimal (0.05 = 5%)
  'metrics.average_cpc': 'cpc_usd',       // divide by 1,000,000
  'metrics.average_cpm': 'cpm_usd',       // divide by 1,000,000
  'metrics.cost_per_conversion': 'cpa_usd', // divide by 1,000,000
} as const;
```

---

## Unified Schema (BigQuery: `marketing_metrics`)

```sql
CREATE TABLE `vertex_analytics.marketing_metrics`
(
  -- Partitioning & clustering keys
  tenant_id         STRING NOT NULL,
  date              DATE NOT NULL,
  ingested_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),

  -- Platform identifiers
  platform          STRING NOT NULL,         -- 'meta', 'tiktok', 'google_ads'
  account_id        STRING NOT NULL,
  campaign_id       STRING NOT NULL,
  campaign_name     STRING,
  adset_id          STRING,                  -- NULL for campaign-level rows
  adset_name        STRING,
  ad_id             STRING,                  -- NULL for adset-level rows
  ad_name           STRING,

  -- Core metrics (normalized to USD, whole numbers for counts)
  impressions       INT64,
  clicks            INT64,
  spend_usd         FLOAT64,
  conversions       FLOAT64,
  conversion_value_usd FLOAT64,

  -- Derived rates (calculated on ingestion, NOT via BigQuery views to save query cost)
  ctr               FLOAT64,                 -- clicks / impressions * 100
  cpc_usd           FLOAT64,                 -- spend / clicks
  cpm_usd           FLOAT64,                 -- spend / impressions * 1000
  cpa_usd           FLOAT64,                 -- spend / conversions
  roas              FLOAT64,                 -- conversion_value / spend

  -- Reach & frequency
  reach             INT64,
  frequency         FLOAT64,                 -- impressions / reach

  -- Video metrics
  video_views       INT64,

  -- Platform-specific extras (JSONB for forward compatibility)
  extras            JSON,                    -- e.g., TikTok 2s/6s views, Meta video quartiles

  -- ML scoring outputs (populated by ml-scoring-service)
  anomaly_score     FLOAT64,                 -- 0-1, higher = more anomalous
  fatigue_score     FLOAT64,                 -- 0-1, higher = more fatigued
  pacing_alert      BOOL DEFAULT FALSE,
)
PARTITION BY date
CLUSTER BY tenant_id, platform, campaign_id
OPTIONS (
  partition_expiration_days = 730,           -- 2 year retention
  require_partition_filter = TRUE            -- prevent full table scans
);
```

### Derived Metrics Calculation Rules
```typescript
// Applied in normalization layer BEFORE BigQuery write
// Prevents division-by-zero with null coalescing
function calculateDerivedMetrics(row: RawMetricRow): NormalizedMetricRow {
  const impressions = row.impressions ?? 0;
  const clicks = row.clicks ?? 0;
  const spend = row.spend_usd ?? 0;
  const conversions = row.conversions ?? 0;
  const conversion_value = row.conversion_value_usd ?? 0;
  const reach = row.reach ?? 0;

  return {
    ...row,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc_usd: clicks > 0 ? spend / clicks : null,
    cpm_usd: impressions > 0 ? (spend / impressions) * 1000 : null,
    cpa_usd: conversions > 0 ? spend / conversions : null,
    roas: spend > 0 ? conversion_value / spend : null,
    frequency: reach > 0 ? impressions / reach : null,
  };
}
```

---

## Incremental Sync Strategy

```
Initial sync: Last 30 days on connector setup
Incremental: Every 6 hours (Cloud Scheduler → Pub/Sub)
Backfill: Manual trigger via API + Cloud Run Job
Deduplication: Upsert via BigQuery MERGE on (tenant_id, date, platform, ad_id)
Late data handling: Meta data can change up to 28 days post-date; re-sync last 3 days on each run

Watermark tracking (Cloud SQL: sync_state table):
  tenant_id, platform, account_id, last_sync_at, last_synced_date, status
```

---

## Error Taxonomy

| Error Code | Platform | Action |
|-----------|---------|--------|
| `190` / token expired | Meta | Trigger re-auth flow, notify tenant admin |
| `32` / permission denied | Meta | Alert, pause connector |
| `40001` / invalid token | TikTok | Trigger re-auth flow |
| `50001` / rate limit | TikTok | Exponential backoff, DLQ |
| `AUTHENTICATION_ERROR` | Google Ads | Trigger re-auth flow |
| `QUOTA_ERROR` | Google Ads | Exponential backoff, alert |
| `INVALID_ARGUMENT` | All | Log, skip record, continue batch |

All connector errors are written to `Cloud Logging` with severity `ERROR` and structured fields: `tenant_id`, `platform`, `error_code`, `error_message`, `endpoint`, `retry_count`.
