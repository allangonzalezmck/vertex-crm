-- =============================================================================
-- Migration: 003_ai_agent_schema
-- Description: AI Sales Agent tables — conversations, turns, connector configs,
--              channel configs, knowledge base documents, sync history
-- Dependencies: 002_crm_schema
-- =============================================================================

-- =============================================================================
-- CHANNEL & CONNECTOR CONFIGS
-- =============================================================================

CREATE TABLE connector_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'google', 'linkedin')),
    display_name    TEXT,
    -- config_plain is only used in development; production uses config_encrypted + KMS
    config_plain    JSONB,
    config_encrypted BYTEA,    -- KMS-encrypted blob (per-tenant DEK)
    kms_key_version TEXT,      -- Cloud KMS key version resource name
    is_active       BOOL NOT NULL DEFAULT true,
    last_sync_at    TIMESTAMPTZ,
    last_sync_status TEXT CHECK (last_sync_status IN ('success', 'partial', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, platform)
);

CREATE TABLE channel_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram', 'tiktok', 'web')),
    config_plain    JSONB,
    config_encrypted BYTEA,
    kms_key_version TEXT,
    is_active       BOOL NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, channel)
);

-- =============================================================================
-- TENANT AGENT CONFIGURATION
-- =============================================================================

CREATE TABLE tenant_agent_configs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
    agent_name              TEXT NOT NULL DEFAULT 'Alex',
    agent_persona           TEXT NOT NULL DEFAULT '',
    business_name           TEXT NOT NULL DEFAULT '',
    deal_value_threshold    NUMERIC(15,2) NOT NULL DEFAULT 10000,
    calendar_link           TEXT,
    human_handoff_email     TEXT NOT NULL,
    language_code           TEXT NOT NULL DEFAULT 'auto',
    is_active               BOOL NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- CONVERSATIONS
-- =============================================================================

CREATE TABLE conversations (
    id              TEXT PRIMARY KEY,    -- Format: "{channel}:{phone_number_id}:{user_id}"
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
    channel         TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram', 'tiktok', 'web')),
    external_user_id TEXT NOT NULL,      -- Platform-specific user ID
    -- FSM state
    state           TEXT NOT NULL DEFAULT 'GREETING',
    -- Agent scoring
    lead_quality_score  INT CHECK (lead_quality_score BETWEEN 0 AND 100),
    sentiment_avg       NUMERIC(4,3),
    -- Handoff tracking
    handoff_at          TIMESTAMPTZ,
    handoff_reason      TEXT,
    handoff_assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Booking
    booked_at           TIMESTAMPTZ,
    cal_booking_uid     TEXT,
    -- Metadata
    total_turns         INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_tenant ON conversations (tenant_id, created_at DESC);
CREATE INDEX idx_conversations_lead ON conversations (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_conversations_channel ON conversations (tenant_id, channel);
CREATE INDEX idx_conversations_state ON conversations (tenant_id, state);

-- =============================================================================
-- CONVERSATION TURNS
-- =============================================================================

CREATE TABLE conversation_turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content         TEXT NOT NULL,
    -- NLU metadata (only on inbound turns)
    sentiment_score NUMERIC(4,3),
    intent          TEXT,
    confidence_score NUMERIC(4,3),
    -- FSM state at time of this turn
    fsm_state       TEXT,
    -- Message delivery status (for outbound)
    delivery_status TEXT CHECK (delivery_status IN ('sent', 'delivered', 'read', 'failed')),
    -- RAG metadata
    rag_chunks_used INT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turns_conversation ON conversation_turns (conversation_id, created_at ASC);
CREATE INDEX idx_turns_tenant ON conversation_turns (tenant_id, created_at DESC);

-- =============================================================================
-- KNOWLEDGE BASE DOCUMENTS
-- =============================================================================

CREATE TABLE kb_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    source_type     TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx', 'url', 'csv', 'manual', 'youtube')),
    source_url      TEXT,       -- GCS URI or original URL
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'active', 'failed', 'archived')),
    chunk_count     INT DEFAULT 0,
    -- Vector Search index ID for this document
    index_id        TEXT,
    error_message   TEXT,
    processed_at    TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kb_docs_tenant ON kb_documents (tenant_id, status);

-- =============================================================================
-- SYNC HISTORY
-- =============================================================================

CREATE TABLE sync_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    date_from       DATE NOT NULL,
    date_to         DATE NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('incremental', 'backfill')),
    rows_ingested   INT NOT NULL DEFAULT 0,
    error_count     INT NOT NULL DEFAULT 0,
    errors          JSONB DEFAULT '[]',
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_history_tenant ON sync_history (tenant_id, platform, completed_at DESC);

-- =============================================================================
-- EMAIL INTEGRATION
-- =============================================================================

CREATE TABLE email_integrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
    email_address   TEXT NOT NULL,
    -- Encrypted OAuth tokens
    access_token_encrypted  BYTEA,
    refresh_token_encrypted BYTEA,
    token_expires_at        TIMESTAMPTZ,
    is_active       BOOL NOT NULL DEFAULT true,
    last_sync_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, provider)
);

CREATE INDEX idx_email_integrations_user ON email_integrations (user_id);

-- =============================================================================
-- EMAIL TEMPLATES
-- =============================================================================

CREATE TABLE email_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    -- HTML body with {{variable}} placeholders
    body_html       TEXT NOT NULL,
    body_plain      TEXT,
    category        TEXT,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE connector_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'connector_configs', 'channel_configs', 'tenant_agent_configs',
        'conversation_turns', 'kb_documents', 'sync_history',
        'email_integrations', 'email_templates'
    ]
    LOOP
        EXECUTE format('
            CREATE POLICY tenant_isolation_%s ON %s
            USING (tenant_id = current_setting(''app.current_tenant_id'', true)::UUID)',
            t, t);
    END LOOP;
END;
$$;

-- conversations uses text PK, policy is still on tenant_id column
CREATE POLICY tenant_isolation_conversations ON conversations
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

CREATE TRIGGER set_connector_configs_updated_at BEFORE UPDATE ON connector_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_channel_configs_updated_at BEFORE UPDATE ON channel_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_tenant_agent_configs_updated_at BEFORE UPDATE ON tenant_agent_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_kb_documents_updated_at BEFORE UPDATE ON kb_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-increment total_turns on conversation when a turn is inserted
CREATE OR REPLACE FUNCTION increment_conversation_turns()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations
    SET total_turns = total_turns + 1, updated_at = NOW()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_turn_counter
    AFTER INSERT ON conversation_turns
    FOR EACH ROW EXECUTE FUNCTION increment_conversation_turns();
