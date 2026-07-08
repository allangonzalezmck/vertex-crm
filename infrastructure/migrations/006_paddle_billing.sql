-- ============================================================
-- Migration 006: Paddle billing (replaces Stripe columns)
-- Vertex CRM operates from Costa Rica; Paddle is the Merchant
-- of Record. Stripe columns are dropped in favor of Paddle IDs.
-- ============================================================
BEGIN;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  ADD COLUMN IF NOT EXISTS paddle_customer_id      TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS paddle_subscription_id  TEXT UNIQUE;

COMMENT ON COLUMN tenants.paddle_customer_id IS
  'Paddle Customer ID (ctm_...) — Paddle is Merchant of Record';
COMMENT ON COLUMN tenants.paddle_subscription_id IS
  'Paddle Subscription ID (sub_...)';

COMMIT;

-- ============================================================
-- Peer-review fix: columns referenced by lead.service.ts and the
-- AI sales agent but missing from 002_crm_schema:
--   lead_quality_score  → AI agent's conversation-derived score (0-100)
--   sentiment_score     → average conversation sentiment (-1.0 to 1.0)
--   conversation_id     → link to originating AI conversation
--   booking_ref         → Cal.com booking reference
-- lead_score (manual/rule-based) is kept separately.
-- ============================================================
BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lead_quality_score INT
      CHECK (lead_quality_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(3,2)
      CHECK (sentiment_score BETWEEN -1.0 AND 1.0),
  ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS booking_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_quality_score
  ON leads (tenant_id, lead_quality_score DESC NULLS LAST)
  WHERE deleted_at IS NULL;

COMMIT;

-- ============================================================
-- Peer-review fix: 001 defined plan CHECK ('trial','standard',
-- 'professional','enterprise') while billing-service and 005 use
-- ('starter','growth','scale','enterprise'). Reconcile to the
-- billing-service canonical set and migrate any legacy values.
-- ============================================================
BEGIN;

UPDATE tenants SET plan = CASE plan
  WHEN 'trial'        THEN 'starter'
  WHEN 'standard'     THEN 'starter'
  WHEN 'professional' THEN 'growth'
  ELSE plan END
WHERE plan IN ('trial', 'standard', 'professional');

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('starter', 'growth', 'scale', 'enterprise'));
ALTER TABLE tenants ALTER COLUMN plan SET DEFAULT 'starter';

COMMIT;
