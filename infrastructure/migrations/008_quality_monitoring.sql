-- ============================================================
-- Migration 008: GAP-03 (quality monitoring) + GAP-04 support
--  - quality fields on channel_configs
--  - channel_health_events audit table (RLS, tenant-isolated)
-- Idempotent, safe to re-run.
-- ============================================================
BEGIN;

ALTER TABLE channel_configs
  ADD COLUMN IF NOT EXISTS quality_rating TEXT
      CHECK (quality_rating IN ('GREEN', 'YELLOW', 'RED', 'UNKNOWN')),
  ADD COLUMN IF NOT EXISTS messaging_tier TEXT,
  ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS channel_health_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,
    source      TEXT NOT NULL,          -- webhook field name or 'poll'
    event_type  TEXT NOT NULL,          -- FLAGGED / DOWNGRADE / QUALITY_RED / ...
    old_value   TEXT,
    new_value   TEXT,
    raw         JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_events_tenant
  ON channel_health_events (tenant_id, created_at DESC);

ALTER TABLE channel_health_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies WHERE tablename = 'channel_health_events'
  ) THEN
    CREATE POLICY tenant_isolation_channel_health_events ON channel_health_events
      USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
  END IF;
END $$;

COMMIT;
