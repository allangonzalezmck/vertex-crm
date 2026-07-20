-- ============================================================
-- Migration 007: GAP-01 + GAP-02 fixes
--  GAP-01: connector token expiry tracking + auth status
--  GAP-02: media archive columns on conversation_turns
-- Safe to re-run (IF NOT EXISTS / idempotent).
-- ============================================================
BEGIN;

-- GAP-01 — token lifecycle on connectors
ALTER TABLE connector_configs
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_status TEXT NOT NULL DEFAULT 'ok'
      CHECK (auth_status IN ('ok', 'expiring_soon', 'needs_reauth'));

CREATE INDEX IF NOT EXISTS idx_connectors_token_expiry
  ON connector_configs (token_expires_at)
  WHERE is_active = true AND token_expires_at IS NOT NULL;

-- GAP-02 — media archived from WhatsApp (Meta deletes originals ~30 days)
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS media_type TEXT
      CHECK (media_type IN ('image', 'audio', 'video', 'document')),
  ADD COLUMN IF NOT EXISTS media_gcs_path TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT;

COMMENT ON COLUMN conversation_turns.media_gcs_path IS
  'gs:// path of the archived attachment in the tenant media bucket (GAP-02)';

COMMIT;
