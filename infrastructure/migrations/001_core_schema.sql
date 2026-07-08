-- =============================================================================
-- Migration: 001_core_schema
-- Description: Core tenant/user/auth schema with Row Level Security
-- Run order: 1 (must be first migration)
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- For full-text search on names/emails
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- For range-based exclusion constraints

-- =============================================================================
-- TENANTS
-- =============================================================================

CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL UNIQUE,   -- URL-safe identifier (e.g. "acme-corp")
    name            TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'standard' CHECK (plan IN ('trial', 'standard', 'professional', 'enterprise')),
    plan_expires_at TIMESTAMPTZ,
    stripe_customer_id  TEXT,
    stripe_subscription_id TEXT,
    -- Tenant-level settings
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    currency        TEXT NOT NULL DEFAULT 'USD',
    locale          TEXT NOT NULL DEFAULT 'en-US',
    -- Limits enforced at application layer
    seat_limit      INT NOT NULL DEFAULT 5,
    monthly_email_limit INT NOT NULL DEFAULT 5000,
    is_active       BOOL NOT NULL DEFAULT true,
    -- Metadata
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_stripe_customer ON tenants (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- =============================================================================
-- USERS
-- =============================================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Google Identity Platform UID (sub claim from JWT)
    gip_uid         TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    avatar_url      TEXT,
    -- Role within this tenant
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer')),
    is_active       BOOL NOT NULL DEFAULT true,
    last_sign_in_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Email must be unique within a tenant
    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant_id ON users (tenant_id);
CREATE INDEX idx_users_gip_uid ON users (gip_uid);
CREATE INDEX idx_users_email ON users (email);

-- =============================================================================
-- AUDIT LOG
-- =============================================================================

CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,   -- NOT FK — audit logs must survive tenant deletion
    user_id         UUID,
    action          TEXT NOT NULL,   -- e.g. 'lead.created', 'deal.status_changed'
    resource_type   TEXT NOT NULL,   -- e.g. 'lead', 'deal', 'contact'
    resource_id     UUID,
    -- JSON diff: { before: {...}, after: {...} }
    payload         JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partitioned by month for efficient purging
-- Note: In production this should be a partitioned table; simplified here for beta
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs (tenant_id, resource_type, resource_id);
CREATE INDEX idx_audit_logs_user ON audit_logs (user_id) WHERE user_id IS NOT NULL;

-- =============================================================================
-- CUSTOM FIELDS DEFINITION
-- =============================================================================

CREATE TABLE custom_field_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('lead', 'contact', 'account', 'deal')),
    field_key       TEXT NOT NULL,   -- Machine name (snake_case)
    label           TEXT NOT NULL,
    field_type      TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email', 'phone')),
    options         JSONB,           -- For select/multi_select: [{ value: "...", label: "..." }]
    is_required     BOOL NOT NULL DEFAULT false,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, entity_type, field_key)
);

CREATE INDEX idx_custom_fields_tenant_entity ON custom_field_definitions (tenant_id, entity_type);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

-- Enable RLS on all tenant-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;

-- App role — used by the application pool (not superuser)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vertex_app') THEN
        CREATE ROLE vertex_app;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO vertex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vertex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vertex_app;

-- CRITICAL: ensure tables created by FUTURE migrations automatically
-- grant privileges to the app role. Without this, migrations 002+ create
-- tables the application cannot read (permission denied at runtime).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vertex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO vertex_app;

-- Admin role for cross-tenant operations (migrations, billing aggregation,
-- system jobs). BYPASSRLS lets it read all tenants. Referenced by
-- shared/src/utils/database.ts withAdminClient().
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vertex_admin') THEN
        CREATE ROLE vertex_admin BYPASSRLS;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO vertex_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vertex_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vertex_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vertex_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO vertex_admin;

-- RLS Policies: enforce tenant_id = current_setting('app.current_tenant_id')
-- This setting is SET LOCAL at the start of each request transaction.

CREATE POLICY tenant_isolation_users ON users
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY tenant_isolation_audit ON audit_logs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY tenant_isolation_custom_fields ON custom_field_definitions
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
