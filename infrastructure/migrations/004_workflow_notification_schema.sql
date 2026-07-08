-- =============================================================================
-- 004_workflow_notification_schema.sql
-- Workflow Engine + Notification Service tables
-- Extends 003_ai_agent_schema.sql
-- =============================================================================

-- ─── Workflow Engine ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL,
  conditions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  run_count       BIGINT NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  updated_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workflow_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant_trigger
  ON workflows(tenant_id, trigger_type)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trigger_type      TEXT NOT NULL,
  trigger_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL CHECK (status IN ('running','completed','failed','skipped')),
  action_results    JSONB,
  error_message     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,

  -- Auto-partition by started_at month (handled by pg_partman in prod)
  CHECK (started_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow
  ON workflow_executions(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant_status
  ON workflow_executions(tenant_id, status, started_at DESC);

-- Update workflow run count on execution insert
CREATE OR REPLACE FUNCTION increment_workflow_run_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    UPDATE workflows SET run_count = run_count + 1, last_run_at = NEW.completed_at
    WHERE id = NEW.workflow_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_run_count ON workflow_executions;
CREATE TRIGGER trg_workflow_run_count
  AFTER UPDATE OF status ON workflow_executions
  FOR EACH ROW EXECUTE FUNCTION increment_workflow_run_count();

-- RLS
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflows_tenant_isolation ON workflows
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY workflow_executions_tenant_isolation ON workflow_executions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON workflows TO vertex_app;
GRANT SELECT, INSERT, UPDATE ON workflow_executions TO vertex_app;

-- ─── Notification Service ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(tenant_id, user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms','push','in_app')),
  recipient       TEXT NOT NULL,
  template_id     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','failed','bounced')),
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_tenant_status
  ON notification_log(tenant_id, status, created_at DESC);

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant_isolation ON notifications
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY notification_log_tenant_isolation ON notification_log
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON notifications TO vertex_app;
GRANT SELECT, INSERT, UPDATE ON notification_log TO vertex_app;

-- ─── updated_at triggers ──────────────────────────────────────────────────────

CREATE TRIGGER set_updated_at_workflows
  BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Seed: Default Workflow Templates ─────────────────────────────────────────
-- These are NOT tenant-specific — copied to tenant on onboarding.

COMMENT ON TABLE workflows IS 'Automation workflows: trigger conditions → action chains per tenant';
COMMENT ON TABLE notifications IS 'In-app notification inbox per user';
COMMENT ON TABLE notification_log IS 'Delivery log for all outbound notifications (email/SMS/push)';
