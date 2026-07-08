# Vertex CRM — GCP Service Map
## Doc 1: GCP Architecture Reference

---

## 1. Service Inventory

| Service | GCP Product | Purpose | Min Instances | Max Instances | vCPU | Memory |
|---------|-------------|---------|--------------|--------------|------|--------|
| `api-gateway` | Cloud Run | Edge routing, auth middleware, rate limiting | 1 | 100 | 2 | 1 GiB |
| `crm-service` | Cloud Run | Leads, Contacts, Accounts, Deals, Activities | 0 | 100 | 1 | 512 MiB |
| `marketing-intelligence` | Cloud Run | Ad platform connectors, metric normalization | 0 | 50 | 2 | 1 GiB |
| `ai-sales-agent` | Cloud Run | Omnichannel chatbot, RAG, booking | 1 | 100 | 2 | 2 GiB |
| `workflow-engine` | Cloud Run | Trigger-condition-action automation | 0 | 50 | 1 | 512 MiB |
| `billing-service` | Cloud Run | Stripe webhooks, plan enforcement | 0 | 20 | 1 | 512 MiB |
| `notification-service` | Cloud Run | Email, SMS, push dispatch | 0 | 50 | 1 | 512 MiB |
| `embedding-service` | Cloud Run (Python) | Chunk, embed, upsert to Vector Search | 0 | 20 | 4 | 4 GiB |
| `ml-scoring-service` | Cloud Run (Python) | Anomaly detection, fatigue scoring, attribution | 0 | 20 | 4 | 8 GiB |
| `ingestion-worker` | Cloud Run Jobs | Scheduled ad-platform ingestion | N/A | 100 concurrent | 2 | 2 GiB |

**Concurrency settings**: All Cloud Run services use `--concurrency 80` (Fastify handles async well). `embedding-service` and `ml-scoring-service` set `--concurrency 10` due to GPU/CPU-bound work.

---

## 2. Database Tier

### Cloud SQL (PostgreSQL 15)

```
Instance: vertex-crm-primary
Tier: db-custom-4-15360 (dev) → db-custom-8-30720 (prod)
Storage: SSD, 100 GiB auto-expand to 1 TiB
HA: Regional (primary + standby replica in same region)
Read replicas: 1 (dev), 2 (prod) — for reporting queries
Backup: Automated daily, PITR enabled, 7-day retention (dev) / 30-day (prod)
Connection: Private IP only via Private Service Connect
Connection pooling: Cloud SQL Auth Proxy + PgBouncer sidecar (pool_mode=transaction)
Max connections: 500 (PgBouncer pools to 50 per service)
```

**AlloyDB Migration Path**: Schema is AlloyDB-compatible. Migration trigger: > 200 active tenants or p99 query latency > 50ms. Estimated effort: 2 sprints (data copy via Database Migration Service, zero-downtime cutover with dual-write period).

### BigQuery

```
Dataset: vertex_analytics (multi-region US)
Tables:
  - marketing_metrics          (partitioned by date, clustered by tenant_id, platform)
  - conversation_logs          (partitioned by created_at, clustered by tenant_id)
  - lead_events                (partitioned by event_time, clustered by tenant_id)
  - audit_log                  (partitioned by timestamp, clustered by tenant_id)
  - ml_predictions             (partitioned by prediction_date, clustered by tenant_id, model_type)
Retention: 90 days hot / unlimited cold (long-term storage pricing)
Authorized views per tenant: enforced via BQ IAM + RLS policies
```

### Memorystore (Redis 7)

```
Tier: Standard (HA with replica)
Capacity: 2 GiB (dev), 10 GiB (prod)
Use cases:
  - Session store (TTL 8h)
  - API response cache (TTL varies by endpoint: 30s–5m)
  - Pub/Sub deduplication (TTL 24h)
  - Rate limit counters (sliding window)
  - Webhook idempotency keys (TTL 72h)
  - AI agent conversation state (TTL 24h per session)
```

---

## 3. Networking Topology

```
┌─────────────────────────────────────────────────────────────┐
│  VPC: vertex-crm-vpc (10.0.0.0/16)                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Subnet: services (10.0.1.0/24) — us-central1       │   │
│  │  Cloud Run → VPC via Serverless VPC Connector        │   │
│  │  Connector: vertex-vpc-connector (e2-micro, /28)      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Subnet: data (10.0.2.0/24)                         │   │
│  │  Cloud SQL: Private IP 10.0.2.10                    │   │
│  │  Memorystore: 10.0.2.20–23                          │   │
│  │  Private Service Connect endpoint                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Cloud NAT: vertex-cloud-nat (egress to external APIs)       │
│  Static IP pool: 5 IPs (whitelisted by Meta, TikTok, etc.)  │
│                                                              │
│  Firewall rules:                                             │
│  - DENY all ingress (default)                                │
│  - ALLOW internal 10.0.0.0/16 → all ports                   │
│  - ALLOW Cloud Run health checks (35.191.0.0/16)            │
│  - DENY egress to metadata server from service accounts      │
└─────────────────────────────────────────────────────────────┘

External:
  Cloud Load Balancer (HTTPS) → Cloud Armor (WAF) → Cloud Run api-gateway
  Cloud CDN → Frontend (Next.js on Cloud Run or Firebase Hosting)
  Cloud Armor rules: OWASP CRS 3.3, rate limit 1000 req/min per IP
```

**Private Service Connect**: Cloud SQL and Memorystore are accessed via PSC endpoints. No public IPs on data tier in any environment.

**Service-to-Service Auth**: All internal calls use Workload Identity + service account OIDC tokens. The `api-gateway` validates tokens; downstream services validate the `X-Tenant-ID` header set by gateway (never trust client-supplied tenant ID).

---

## 4. Async Infrastructure (Pub/Sub)

| Topic | Publishers | Subscribers | Message Schema | Retention |
|-------|-----------|-------------|----------------|-----------|
| `lead.created` | crm-service | workflow-engine, notification-service, ai-sales-agent | LeadCreatedEvent | 7d |
| `lead.updated` | crm-service | workflow-engine, ml-scoring-service | LeadUpdatedEvent | 7d |
| `deal.stage.changed` | crm-service | workflow-engine, notification-service | DealStageEvent | 7d |
| `marketing.ingestion.trigger` | Cloud Scheduler | marketing-intelligence | IngestionTriggerEvent | 1d |
| `marketing.metrics.ingested` | marketing-intelligence | ml-scoring-service, workflow-engine | MetricsIngestedEvent | 7d |
| `conversation.turn` | ai-sales-agent | crm-service, ml-scoring-service | ConversationTurnEvent | 7d |
| `conversation.ended` | ai-sales-agent | crm-service, notification-service | ConversationEndedEvent | 7d |
| `workflow.triggered` | workflow-engine | workflow-engine (self, for async steps) | WorkflowStepEvent | 3d |
| `email.send` | notification-service, workflow-engine | notification-service | EmailSendEvent | 1d |
| `audit.event` | all services | audit-log-writer (Cloud Run Job) | AuditEvent | 30d |
| `billing.subscription.updated` | billing-service | crm-service, all services | BillingEvent | 7d |

**Dead Letter Topics**: Every subscription has a DLQ topic with 5 retry attempts (exponential backoff: 10s, 20s, 40s, 80s, 160s). DLQ messages trigger PagerDuty alerts.

---

## 5. Data Flow Diagrams

### Pillar 1: Marketing Intelligence Hub

```
┌─────────────────────────────────────────────────────────────────┐
│                    Marketing Intelligence Flow                   │
└─────────────────────────────────────────────────────────────────┘

Cloud Scheduler (every 6h)
         │
         ▼
  Pub/Sub: marketing.ingestion.trigger
         │
         ▼
  marketing-intelligence (Cloud Run)
    │
    ├─► META Marketing API v19
    │     OAuth token (Secret Manager) → /act_*/insights (batch)
    │     → normalize → write Cloud SQL: raw_ad_metrics
    │
    ├─► TikTok Marketing API
    │     OAuth token → /report/integrated/get
    │     → normalize → write Cloud SQL: raw_ad_metrics
    │
    └─► Google Ads API v16
          OAuth token + developer token → GoogleAdsService.SearchStream
          → normalize → write Cloud SQL: raw_ad_metrics
                │
                ▼
         Cloud SQL: raw_ad_metrics (staging table)
                │
                ▼
    BigQuery Streaming Insert (unified schema)
    marketing_metrics table (partitioned, clustered)
                │
         ┌──────┴──────┐
         ▼             ▼
  Pub/Sub: metrics    Vertex AI ML Pipeline
  .ingested           (anomaly detection,
         │             fatigue scoring,
         ▼             attribution)
  ml-scoring-service       │
         │                 ▼
         └──────► BigQuery: ml_predictions
                       │
                       ▼
              Memorystore cache (5-min TTL)
                       │
                       ▼
         Frontend Dashboard (Next.js)
         ← GraphQL Subscription (real-time)
         ← REST /api/marketing/metrics (paginated)
```

### Pillar 2: AI Sales Agent

```
┌─────────────────────────────────────────────────────────────────┐
│                     AI Sales Agent Flow                          │
└─────────────────────────────────────────────────────────────────┘

Inbound Message (any channel)
    │
    ├─► WhatsApp Business API (360dialog webhook)
    ├─► Facebook Messenger Platform webhook
    ├─► Instagram Direct webhook
    └─► TikTok Business API webhook
    │
    ▼
Cloud Load Balancer → Cloud Armor (webhook signature validation)
    │
    ▼
api-gateway → ai-sales-agent (Cloud Run)
    │
    ▼
Channel Adapter (normalize to InboundMessage schema)
    │
    ▼
Conversation State Manager
  └─► Memorystore: session:{tenantId}:{userId} (24h TTL)
      - conversation_state (FSM state)
      - collected_fields
      - turn_count
      - sentiment_history
    │
    ▼
RAG Pipeline
  ├─► Vertex AI Text Embedding API (text-embedding-004)
  │     embed user message
  │
  └─► Vertex AI Vector Search
        query tenant's knowledge base index
        return top-5 chunks (cosine similarity > 0.80)
    │
    ▼
Vertex AI Gemini 1.5 Flash (response generation)
  System prompt: tenant persona + conversation state + RAG chunks
  Grounding: only facts from retrieved chunks
    │
    ├─ confidence < 0.65 → HANDOFF
    ├─ escalation keyword → HANDOFF
    └─ normal → send reply via channel adapter
    │
    ▼
Pub/Sub: conversation.turn
    │
    ├─► crm-service: upsert Lead record, append transcript turn
    └─► ml-scoring-service: sentiment + quality scoring
    │
    ▼ (on BOOK_CALL state)
Cal.com API
  GET /api/v1/slots → propose 2 slots
  POST /api/v1/bookings → confirm
    │
    ▼
Pub/Sub: conversation.ended
    ├─► crm-service: write full transcript, booking ref, scores
    └─► notification-service: alert assigned rep
```

---

## 6. Identity & Auth Flow

```
Browser/App
    │
    ▼
Google Identity Platform (Firebase Auth multi-tenant)
    │
    ├─► Social: Google, Microsoft OIDC
    ├─► Enterprise: SAML 2.0 / OIDC SSO (per tenant IdP)
    └─► Email/Password (bcrypt, enforced MFA for admin)
    │
    ▼
ID Token (JWT, tenant-scoped)
    │
    ▼
api-gateway middleware:
  1. Verify JWT signature (Identity Platform JWKS)
  2. Extract tenant_id from custom claim
  3. Check plan entitlements (Memorystore cache → billing-service)
  4. Set X-Tenant-ID, X-User-ID, X-Plan headers
  5. Forward to downstream service
    │
    ▼
Downstream service:
  - NEVER reads tenant_id from client headers
  - Reads ONLY from context set by gateway
  - PostgreSQL: SET LOCAL app.current_tenant_id = '{tenant_id}'
  - RLS policy: WHERE tenant_id = current_setting('app.current_tenant_id')
```

---

## 7. Secret Management

| Secret Name | Rotation | Access |
|-------------|----------|--------|
| `vertex/db/primary-password` | 90 days | crm-service, workflow-engine SA |
| `vertex/redis/auth-token` | 180 days | all services SA |
| `vertex/meta/app-secret` | Manual | marketing-intelligence SA |
| `vertex/tiktok/app-secret` | Manual | marketing-intelligence SA |
| `vertex/google-ads/developer-token` | Manual | marketing-intelligence SA |
| `vertex/stripe/secret-key` | Manual | billing-service SA |
| `vertex/twilio/auth-token` | 90 days | notification-service SA |
| `vertex/calcom/api-key` | 90 days | ai-sales-agent SA |
| `vertex/vertex/service-account-key` | 90 days | ml-scoring-service SA |
| `vertex/tenant/{id}/dek` | Per-tenant | Cloud KMS (enterprise tier) |

---

## 8. Cost Model

### 0–50 Tenants (Startup Phase)
```
Cloud Run:          ~$120/month  (mostly min=0, ~2M requests/month)
Cloud SQL:          ~$180/month  (db-custom-2-7680, 1 HA instance)
BigQuery:           ~$30/month   (~50 GiB storage, ~100 GiB queries)
Memorystore:        ~$70/month   (2 GiB Standard)
Pub/Sub:            ~$10/month   (~1M messages)
Vertex AI:          ~$200/month  (Gemini Flash API, embeddings, Vector Search)
Networking:         ~$40/month   (Cloud Armor, CDN, egress)
Secret Manager:     ~$5/month
Total:              ~$655/month
Per-tenant cost:    ~$13/tenant/month at 50 tenants
```

### 50–500 Tenants (Growth Phase)
```
Cloud Run:          ~$600/month  (sustained traffic, ~20M requests)
Cloud SQL:          ~$900/month  (db-custom-8-30720, 2 read replicas)
BigQuery:           ~$400/month  (~500 GiB storage, ~1 TiB queries)
Memorystore:        ~$280/month  (10 GiB Standard)
Pub/Sub:            ~$80/month   (~8M messages)
Vertex AI:          ~$1,800/month (scale with conversation volume)
Cloud Armor:        ~$200/month
Networking:         ~$300/month
AlloyDB (upgrade):  ~$1,200/month (replaces Cloud SQL at this tier)
Total:              ~$5,760/month
Per-tenant cost:    ~$11.52/tenant/month at 500 tenants (economies of scale)
```

### 500+ Tenants (Scale Phase)
```
Committed Use Discounts (1-year): 30% off compute
Cloud Run (committed):  ~$3,000/month
AlloyDB cluster:        ~$4,500/month (HA + 3 read replicas)
BigQuery (flat-rate):   ~$2,500/month (2 slots reserved)
Vertex AI:              ~$8,000/month (provisioned throughput)
Memorystore (20 GiB):   ~$560/month
Pub/Sub:                ~$400/month
Networking + CDN:       ~$800/month
Total:                  ~$19,760/month
Per-tenant cost:        ~$3.95/tenant/month at 5000 tenants
```

**Cost optimization levers**:
- Vertex AI: use Flash for agent responses (10x cheaper than Pro), reserve Pro for complex analytics insights
- BigQuery: partition pruning via date filters enforced in all query patterns
- Cloud Run: `--no-cpu-throttling` only on `ai-sales-agent` (latency-sensitive); all others throttled
- Committed Use Discounts at 50+ tenants for predictable workloads

---

## 9. SLO Targets

| Service | Availability | p50 Latency | p95 Latency | p99 Latency |
|---------|-------------|-------------|-------------|-------------|
| api-gateway | 99.9% | 50ms | 200ms | 500ms |
| crm-service | 99.9% | 100ms | 300ms | 800ms |
| ai-sales-agent (response) | 99.5% | 2s | 5s | 8s |
| marketing-intelligence (ingestion) | 99.0% | N/A (async) | N/A | N/A |
| Frontend (Core Web Vitals) | 99.9% | LCP < 2.5s | FID < 100ms | CLS < 0.1 |

Error budget alerting: burn-rate alerts at 2% hourly, 5% daily via Cloud Monitoring.
