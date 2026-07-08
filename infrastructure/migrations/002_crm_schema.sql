-- =============================================================================
-- Migration: 002_crm_schema
-- Description: Core CRM entities — Leads, Contacts, Accounts, Deals, Activities, Pipelines
-- Dependencies: 001_core_schema
-- =============================================================================

-- =============================================================================
-- PIPELINES & STAGES
-- =============================================================================

CREATE TABLE pipelines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    is_default      BOOL NOT NULL DEFAULT false,
    currency        TEXT NOT NULL DEFAULT 'USD',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE pipeline_stages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    probability     INT NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
    -- 'open' | 'won' | 'lost' — terminal stages affect reporting
    stage_type      TEXT NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open', 'won', 'lost')),
    color           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pipeline_id, name)
);

CREATE INDEX idx_pipeline_stages_pipeline ON pipeline_stages (pipeline_id, sort_order);

-- =============================================================================
-- LEADS
-- =============================================================================

CREATE TABLE leads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Identity
    first_name      TEXT,
    last_name       TEXT,
    email           TEXT,
    phone           TEXT,
    company_name    TEXT,
    job_title       TEXT,
    website         TEXT,
    linkedin_url    TEXT,
    -- Lead management
    status          TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new', 'contacted', 'qualified', 'unqualified', 'converted')),
    source          TEXT,    -- 'website', 'ai_agent_whatsapp', 'import', 'manual', etc.
    source_detail   TEXT,    -- Campaign name, referrer URL, etc.
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Score
    lead_score      INT CHECK (lead_score BETWEEN 0 AND 100),
    -- Address
    address_street  TEXT,
    address_city    TEXT,
    address_state   TEXT,
    address_country TEXT,
    address_zip     TEXT,
    -- CRM metadata
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    -- Conversion tracking
    converted_at    TIMESTAMPTZ,
    converted_contact_id UUID,   -- Set when converted to Contact
    converted_account_id UUID,   -- Set when converted to Account
    converted_deal_id    UUID,   -- Set when converted to Deal
    -- Soft delete
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_activity_at TIMESTAMPTZ
);

CREATE INDEX idx_leads_tenant ON leads (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_status ON leads (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_assigned ON leads (assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_email ON leads (tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_leads_source ON leads (tenant_id, source) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_created ON leads (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_tags ON leads USING GIN (tags);
CREATE INDEX idx_leads_name_trgm ON leads USING GIN (
    (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) gin_trgm_ops
) WHERE deleted_at IS NULL;

-- =============================================================================
-- ACCOUNTS (Companies)
-- =============================================================================

CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    domain          TEXT,
    industry        TEXT,
    employee_count  INT,
    annual_revenue  NUMERIC(15,2),
    website         TEXT,
    linkedin_url    TEXT,
    phone           TEXT,
    -- Address
    address_street  TEXT,
    address_city    TEXT,
    address_state   TEXT,
    address_country TEXT,
    address_zip     TEXT,
    -- CRM
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_tenant ON accounts (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_accounts_name_trgm ON accounts USING GIN (name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX idx_accounts_domain ON accounts (tenant_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL;

-- =============================================================================
-- CONTACTS
-- =============================================================================

CREATE TABLE contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    -- Identity
    first_name      TEXT NOT NULL,
    last_name       TEXT,
    email           TEXT,
    phone           TEXT,
    job_title       TEXT,
    department      TEXT,
    linkedin_url    TEXT,
    avatar_url      TEXT,
    -- CRM
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    email_opt_out   BOOL NOT NULL DEFAULT false,
    -- Source (from lead conversion)
    converted_from_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contacts_tenant ON contacts (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_account ON contacts (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_email ON contacts (tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_contacts_name_trgm ON contacts USING GIN (
    (first_name || ' ' || COALESCE(last_name, '')) gin_trgm_ops
) WHERE deleted_at IS NULL;

-- =============================================================================
-- DEALS
-- =============================================================================

CREATE TABLE deals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Relationships
    pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    stage_id        UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    converted_from_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    -- Deal details
    name            TEXT NOT NULL,
    amount          NUMERIC(15,2),
    currency        TEXT NOT NULL DEFAULT 'USD',
    probability     INT CHECK (probability BETWEEN 0 AND 100),
    expected_close_date DATE,
    actual_close_date DATE,
    -- Stage tracking
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'open' | 'won' | 'lost'
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
    lost_reason     TEXT,
    -- CRM
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deals_tenant ON deals (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_stage ON deals (stage_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_pipeline ON deals (pipeline_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_account ON deals (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_assigned ON deals (assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_close_date ON deals (tenant_id, expected_close_date) WHERE deleted_at IS NULL AND status = 'open';

-- Deal-Contact junction (a deal can involve multiple contacts)
CREATE TABLE deal_contacts (
    deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    role        TEXT,   -- 'champion', 'decision_maker', 'influencer', 'end_user'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (deal_id, contact_id)
);

-- =============================================================================
-- ACTIVITIES
-- =============================================================================

CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Polymorphic association (at least one must be set)
    lead_id         UUID REFERENCES leads(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES contacts(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE CASCADE,
    deal_id         UUID REFERENCES deals(id) ON DELETE CASCADE,
    -- Activity details
    type            TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'task', 'sms', 'whatsapp', 'demo')),
    subject         TEXT NOT NULL,
    description     TEXT,
    outcome         TEXT,
    -- Task fields
    scheduled_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    duration_minutes INT,
    -- Assignment
    assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Metadata
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activities_lead ON activities (lead_id, created_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_activities_contact ON activities (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_activities_deal ON activities (deal_id, created_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX idx_activities_tenant_scheduled ON activities (tenant_id, scheduled_at DESC) WHERE completed_at IS NULL;
CREATE INDEX idx_activities_assigned ON activities (assigned_user_id, scheduled_at) WHERE completed_at IS NULL;

-- =============================================================================
-- RLS POLICIES FOR CRM TABLES
-- =============================================================================

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

-- Generic macro for tenant isolation policy
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pipelines', 'pipeline_stages', 'leads', 'accounts',
                              'contacts', 'deals', 'activities']
    LOOP
        EXECUTE format('
            CREATE POLICY tenant_isolation_%s ON %s
            USING (tenant_id = current_setting(''app.current_tenant_id'', true)::UUID)',
            t, t);
    END LOOP;
END;
$$;

-- deal_contacts isolation via deal's tenant_id
CREATE POLICY tenant_isolation_deal_contacts ON deal_contacts
    USING (
        EXISTS (
            SELECT 1 FROM deals d
            WHERE d.id = deal_contacts.deal_id
            AND d.tenant_id = current_setting('app.current_tenant_id', true)::UUID
        )
    );

-- =============================================================================
-- TRIGGERS
-- =============================================================================

CREATE TRIGGER set_pipelines_updated_at BEFORE UPDATE ON pipelines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_leads_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_accounts_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_contacts_updated_at BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_deals_updated_at BEFORE UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_activities_updated_at BEFORE UPDATE ON activities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Track stage changes for deal velocity reporting
CREATE OR REPLACE FUNCTION track_deal_stage_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
        NEW.stage_changed_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deal_stage_change_tracker
    BEFORE UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION track_deal_stage_change();

-- =============================================================================
-- SEED: Default pipeline for new tenants
-- Note: run via application onboarding flow, not here directly
-- =============================================================================
