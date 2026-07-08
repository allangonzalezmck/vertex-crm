-- ============================================================
-- Migration 005: Billing schema + KB document chunks
-- ============================================================

BEGIN;

-- ── Billing columns on tenants ──────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan              TEXT    NOT NULL DEFAULT 'starter'
                                             CHECK (plan IN ('starter','growth','scale','enterprise')),
  ADD COLUMN IF NOT EXISTS billing_status    TEXT    NOT NULL DEFAULT 'trialing'
                                             CHECK (billing_status IN ('trialing','active','past_due','canceled','paused')),
  ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT UNIQUE;

-- ── KB document chunks ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index   INT  NOT NULL,
  content       TEXT NOT NULL,
  token_count   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_document   ON kb_document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant     ON kb_document_chunks(tenant_id);

-- Add processing columns to kb_documents
ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS chunk_count           INT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_message         TEXT;

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE kb_document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON kb_document_chunks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ── Billing usage view ──────────────────────────────────────
CREATE OR REPLACE VIEW tenant_usage AS
SELECT
  t.id                                                          AS tenant_id,
  t.plan,
  t.billing_status,
  (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active = true)
                                                                AS seats_used,
  (SELECT COUNT(*) FROM leads l WHERE l.tenant_id = t.id AND l.deleted_at IS NULL)
                                                                AS leads_used,
  (SELECT COUNT(*) FROM conversations c
     WHERE c.tenant_id = t.id
       AND c.created_at >= date_trunc('month', now()))          AS ai_conversations_month,
  (SELECT COUNT(*) FROM connector_configs cc
     WHERE cc.tenant_id = t.id AND cc.is_active = true)        AS connectors_active,
  (SELECT COUNT(*) FROM workflow_executions we
     WHERE we.tenant_id = t.id
       AND we.started_at >= date_trunc('month', now()))         AS workflow_executions_month
FROM tenants t;

COMMIT;

-- ── Safety re-grant ─────────────────────────────────────────
-- Ensures the app role has privileges on ALL tables including those
-- created in migrations 002-005 (idempotent, safe to re-run).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vertex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vertex_app;
