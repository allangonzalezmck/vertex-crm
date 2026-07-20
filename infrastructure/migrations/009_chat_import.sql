-- ============================================================
-- Migration 009: GAP-05 — WhatsApp chat history import
--  - conversations.source distinguishes imported history from live AI chats
--  - conversations.state gains 'IMPORTED' (imports never enter the FSM)
--  - chat_import_batches tracks every import for audit + one-click undo
-- Idempotent, safe to re-run.
-- ============================================================
BEGIN;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'
      CHECK (source IN ('live', 'import'));

-- Widen the FSM state check to allow the terminal IMPORTED state
DO $$
DECLARE cdef TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO cdef FROM pg_constraint
   WHERE conrelid = 'conversations'::regclass AND conname = 'conversations_state_check';
  IF cdef IS NOT NULL AND cdef NOT LIKE '%IMPORTED%' THEN
    EXECUTE 'ALTER TABLE conversations DROP CONSTRAINT conversations_state_check';
    EXECUTE replace(cdef, ']))', ', ''IMPORTED''::text]))');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_import_batches (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    gcs_path      TEXT NOT NULL,          -- archived original export file
    message_count INT NOT NULL,
    participants  JSONB NOT NULL,
    date_order    TEXT NOT NULL CHECK (date_order IN ('DMY', 'MDY')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant
  ON chat_import_batches (tenant_id, created_at DESC);

ALTER TABLE chat_import_batches ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'chat_import_batches') THEN
    CREATE POLICY tenant_isolation_chat_import_batches ON chat_import_batches
      USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
  END IF;
END $$;

COMMIT;
