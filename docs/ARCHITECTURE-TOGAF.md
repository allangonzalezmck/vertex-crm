# Vertex CRM — Enterprise Architecture Document (TOGAF 10)

**Document ID:** VTX-EA-001 · **Version:** 1.1 (platform v1.0.1) · **Classification:** Internal
**Architecture Framework:** TOGAF 10 Architecture Development Method (ADM)
**Product:** Vertex CRM — Multi-tenant B2B SaaS CRM · Phase 1 Beta

---

## Phase A — Architecture Vision

### A.1 Business Context

Vertex CRM is a multi-tenant SaaS platform sold through a channel-partner model: a digital marketing agency refers its existing clients (first target vertical: premium fitness — a high-end luxury gym), those clients subscribe and pay Vertex directly, and the agency operates the platform on their behalf (managing ads, leads, and sales closures).

**Operating constraint that shaped the architecture:** the company bills from Costa Rica. Stripe does not accept Costa Rican merchants; therefore the billing architecture uses **Paddle as Merchant of Record (MoR)** — Paddle is the legal seller, handles global VAT/sales-tax in 200+ jurisdictions, chargebacks, and fraud, and pays out to Costa Rica via wire transfer. No US/EU entity is required.

### A.2 Stakeholders and Concerns

| Stakeholder | Concern | Addressed by |
|---|---|---|
| Product owner (Allan) | Time-to-market, cost control, CR billing | Serverless scale-to-zero, Paddle MoR |
| Marketing agency partner | Multi-client management, ad-platform data | Multi-tenancy, Marketing Intelligence Hub |
| Tenant end-customers (e.g., gym) | Lead capture, AI sales agent, dashboards | AI Sales Agent, Lead Journey dashboard |
| Tenant's leads (consumers) | Fast, natural conversation on their channel | WhatsApp/Messenger/Instagram adapters |
| Operations team | Deployable in one day, observable, recoverable | IaC (Terraform), CI/CD, canary deploys |

### A.3 Architecture Principles

1. **Tenant isolation is enforced by the database, not the application.** PostgreSQL Row-Level Security with `SET LOCAL app.current_tenant_id`; application code cannot forget a WHERE clause.
2. **Every capability is a service.** No monolith; each domain deploys, scales, and fails independently.
3. **Asynchronous by default.** Cross-service communication via Pub/Sub push subscriptions; synchronous calls only via the API Gateway.
4. **Stateless compute.** Cloud Run containers hold no session state; all state lives in Cloud SQL, Redis, or BigQuery.
5. **AI is grounded, never free-running.** The sales agent follows a deterministic FSM; all product answers come from tenant-scoped RAG retrieval.
6. **Secrets never touch code.** GCP Secret Manager exclusively; verified in peer review (zero hardcoded credentials).

---

## Phase B — Business Architecture

### B.1 Business Capability Map

| Capability | Description | Realizing Service |
|---|---|---|
| Tenant Lifecycle | Onboarding, workspace, plan management | crm-service + billing-service |
| Lead Management | Capture, score, qualify, convert | crm-service |
| Pipeline Management | Stages, kanban, forecast | crm-service |
| Marketing Intelligence | Meta/TikTok/Google Ads ingestion → unified metrics | marketing-intelligence |
| Conversational Sales | Omnichannel AI agent, qualification, booking | ai-sales-agent |
| Knowledge Management | Tenant KB ingestion → vector embeddings | embedding-service |
| Workflow Automation | Trigger-condition-action engine | workflow-engine |
| Notifications | Email (SendGrid), SMS (Twilio), in-app | notification-service |
| Revenue Operations | Subscriptions, usage limits, dunning | billing-service (Paddle) |
| Access & Identity | Multi-tenant SSO, RBAC | api-gateway + Google Identity Platform |

### B.2 Value Stream — "Lead to Customer Journey"

`Ad impression (Meta/TikTok) → Lead message (WhatsApp/IG) → AI agent greets (FSM: GREETING) → Qualification (QUALIFY) → Product answers via RAG (EDUCATE) → Objection handling (HANDLE_OBJECTION) → Trial booking via Cal.com (BOOK_CALL) → Human closes (HANDOFF) → Deal Won → revenue attributed to originating campaign in BigQuery.`

This value stream is visualized end-to-end in the dashboard (KPI strip → funnel → journey timeline), which was rebuilt in this release to match the approved reference design.

---

## Phase C — Information Systems Architecture

### C.1 Application Architecture — the 9 services

| # | Service | Responsibility | Key Interfaces |
|---|---|---|---|
| 1 | **api-gateway** | Single ingress. JWT validation (Google Identity JWKS), tenant claim extraction, per-tenant rate limiting (Redis sliding window, 2 000 req/min), reverse proxy | REST → all services |
| 2 | **crm-service** | Leads, Contacts, Accounts, Deals, Activities, Pipelines. Dashboard aggregation endpoint (`GET /leads/dashboard`) | REST; publishes lead/deal events |
| 3 | **marketing-intelligence** | OAuth connectors (Meta v19, TikTok Business, Google Ads v16), incremental sync, normalization → BigQuery streaming inserts | REST + Pub/Sub trigger |
| 4 | **ai-sales-agent** | 6-state deterministic FSM, Gemini Flash NLU, Gemini 1.5 Pro generation, RAG (Vertex AI Vector Search, cosine ≥ 0.80), channel adapters (WhatsApp Cloud API, Messenger, Instagram), Cal.com booking | Webhooks in; Pub/Sub out |
| 5 | **workflow-engine** | 8-operator condition evaluator; actions: update_field, add_tag, create_activity, notify_user, send_email, webhook, wait | Pub/Sub push consumer |
| 6 | **billing-service** | **Paddle Billing v2**: hosted checkout transactions, HMAC-verified webhooks (replay-protected, 5-min window), plan limits enforcement (`POST /check-limit` gate), customer portal, scheduled cancellation | REST + Paddle webhooks |
| 7 | **notification-service** | SendGrid email, Twilio SMS, in-app inbox | Pub/Sub push consumer |
| 8 | **embedding-service** | KB pipeline: PDF/DOCX/CSV/URL/YouTube → chunk (512 tok, 64 overlap) → embed (text-embedding-004, 768-dim) → Vector Search upsert with tenant restricts | REST + GCS trigger |
| 9 | **frontend** | Next.js 14 App Router; Aura design system; animated dashboard (Framer Motion spring counters, gradient-depth charts, staggered entrances) | Consumes gateway REST |

### C.2 Data Architecture

**Systems of record**

| Store | Data | Rationale |
|---|---|---|
| Cloud SQL (PostgreSQL 15) | All CRM entities, tenants, conversations, KB metadata, workflows, billing state | ACID, RLS tenant isolation |
| BigQuery (`vertex_analytics`) | `marketing_metrics` (partitioned by date, clustered by tenant_id/platform), ML predictions | Analytical scale, streaming inserts for near-real-time dashboards |
| Vertex AI Vector Search | KB chunk embeddings, tenant-namespaced via restricts | Sub-100 ms ANN retrieval at scale (chosen over pgvector) |
| Memorystore Redis 7 | Rate-limit windows, sync-job state (24 h TTL), conversation context (7 d TTL), RAG chunk cache (5 min TTL) | Low-latency ephemeral state |
| GCS | Raw KB documents (`vertex-kb-*`), uploads | Blob storage, event triggers |

**Tenancy model:** pooled-by-default. Every row carries `tenant_id`; RLS policy `tenant_id = current_setting('app.current_tenant_id')::uuid` on all tenant tables. Two DB roles: `vertex_app` (RLS-enforced) and `vertex_admin` (BYPASSRLS, for system jobs) — both created in migration 001 with `ALTER DEFAULT PRIVILEGES` so tables from later migrations inherit grants (peer-review fix VR-01/VR-05).

**Migration chain (all verified against live PostgreSQL 16):**
001 core (tenants, users, audit, RLS roles) → 002 CRM entities → 003 AI agent (conversations, KB, connectors) → 004 workflows/notifications → 005 billing usage + KB chunks → 006 Paddle columns, AI-scoring columns, plan-constraint reconciliation.

### C.3 Key Data Contracts

- **Unified marketing schema:** impressions, clicks, spend_usd, conversions, CPL, CPA, ROAS, CTR — normalized from three platform field maps into one BigQuery table.
- **Pub/Sub topics (peer-review reconciled, VR-02):** lead.created/updated, deal.stage.changed, marketing.ingestion.trigger/metrics.ingested, conversation.turn/ended/handoff/handoff.requested, workflow.triggered, email.send, audit.event, billing.subscription.updated/plan.changed/limit.warning, crm.events, kb.document.ready, notifications.dispatch. Dead-letter queues after 5 delivery attempts.
- **API envelope:** every REST response is `{ success, data, error?, timestamp, requestId }`.

---

## Phase D — Technology Architecture

### D.1 Platform Topology

```
Internet
  │
  ├── Cloud Load Balancer (HTTPS, managed certs)
  │      ├── app.vertex-crm.io  → Cloud Run: frontend
  │      └── api.vertex-crm.io  → Cloud Run: api-gateway
  │                                   │ (private ingress only ↓)
  │            ┌──────────────────────┼──────────────────────┐
  │            ▼          ▼           ▼          ▼           ▼
  │        crm-service  marketing  ai-agent  workflow   notification
  │            │        intelligence   │      engine        │
  │            └────────────┬──────────┴─────────┬───────────┘
  │                         ▼                    ▼
  │            VPC Connector → Cloud SQL / Memorystore (private IP)
  │                         ▼
  │                     BigQuery · Vertex AI · GCS · Pub/Sub · Secret Manager
  │
  └── Webhooks in: Paddle → billing-service · Meta/WhatsApp → ai-sales-agent
```

### D.2 Technology Standards

| Layer | Standard |
|---|---|
| Runtime | Cloud Run (2nd gen), Node.js 20, TypeScript strict, CommonJS build (top-level await eliminated — peer-review fix VR-03) |
| Networking | VPC 10.0.0.0/16, Serverless VPC Connector, Cloud NAT for egress, private-IP Cloud SQL |
| Identity | Google Identity Platform, OIDC; JWT custom claims `vertex_tenant_id`, `vertex_role`, `vertex_plan` |
| Secrets | Secret Manager, mounted as env vars at deploy |
| IaC | Terraform ≥ 1.5, GCS state backend, workspace per environment |
| CI/CD | Cloud Build: build → push (Artifact Registry) → migrate → canary 10 % → smoke test → 100 % with auto-rollback |
| Observability | Cloud Logging (structured JSON), Cloud Monitoring, Error Reporting, uptime checks on `/health` |

### D.3 Security Architecture

- **Zero Trust:** internal services require IAM-authenticated invocation (`--no-allow-unauthenticated`); only gateway, frontend, and webhook receivers are public.
- **Webhook integrity:** Paddle HMAC-SHA256 with timing-safe compare and 5-minute replay window; WhatsApp verify-token challenge.
- **OWASP:** parameterized SQL exclusively (verified in review), Zod validation at every boundary, Helmet headers, rate limiting, no stack traces to clients (domain-error mapper).
- **Data protection:** per-tenant RLS (tested live: cross-tenant reads return zero rows), TLS in transit, CMEK-ready Cloud SQL.

---

## Phase E/F — Opportunities, Solutions & Migration Planning

| Increment | Scope | Status |
|---|---|---|
| Inc-1 | Core CRM, dashboard per reference design, Paddle billing, AI agent (WhatsApp), Meta/TikTok/Google Ads connectors | **Built & peer-reviewed** |
| Inc-1.1 (v1.0.1) | Data-safety pillar from the Kommo competitive analysis — GAP-01 Meta token lifecycle; GAP-02 WhatsApp media archiving (GCS, pre-30-day-deletion); GAP-03 number quality/tier monitoring (webhook + poll, `channel_health_events` audit); GAP-04 conversation export (CSV/JSON, signed media URLs, RLS-scoped); GAP-05 WhatsApp history import (official Export-chat .txt parser — locale-aware dates, multiline, media placeholders; preview→commit→undo; originals archived) | **Built & tested (18/18 parser tests, 9/9 migrations live)** |
| Inc-2 | Conversations UI, Calendar, Automations UI, Reports pages (backends exist) | Backlog |
| Inc-3 | YouTube connector expansion, email sync (Gmail/Outlook), additional MoR checkout locales | Backlog |
| Inc-4 | AlloyDB migration path, per-tenant CMEK (enterprise tier) | Deferred |

**Billing migration path:** Paddle now (CR-operational day one) → optionally add Stripe under a US LLC at ≥ $50 k MRR, running dual rails (existing subscribers grandfathered on Paddle).

---

## Phase G/H — Governance & Change Management

- **Architecture compliance gate:** PRs must pass parse/lint/test in CI (`pr-checks`), migrations must run with `ON_ERROR_STOP` against a disposable database, and any new cross-service topic must be added to the shared `TOPICS` map (drift caused defect VR-02).
- **Peer-review register (this release):** VR-01 missing table grants for app role; VR-02 six undefined Pub/Sub topics; VR-03 top-level await under CommonJS; VR-04 non-existent `Toast` export import; VR-05 missing `vertex_admin` role; VR-06/07 dashboard SQL column mismatches (`lead_quality_score`, `due_at`→`scheduled_at`); VR-08 service/schema drift on AI-scoring columns; VR-09 FK type mismatch (TEXT vs UUID); VR-10 conflicting plan CHECK constraints. **All ten remediated and re-verified against a live PostgreSQL instance.**
- **v1.0.1 additions:** VR-11 agent webhook routes not reachable through the gateway rewrite (`/webhooks/*` vs `/agent/webhooks/*`); VR-12 gateway rewrites omitted crm-service's `/api/v1` mount prefix (every CRM route would 404 in production); VR-13 exact-match public-route auth check blocked tenant-suffixed webhook URLs. All three fixed and the full chain re-verified. GAP-01…05 register: see Phase E/F Inc-1.1.
- **Change control:** semantic version tags; canary deploys with automated rollback; schema changes only via numbered migrations.

---

*End of document — Vertex CRM Enterprise Architecture, VTX-EA-001 v1.0*
