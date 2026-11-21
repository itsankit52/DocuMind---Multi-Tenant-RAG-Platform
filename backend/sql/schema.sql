--
# Initial Database Schema
-- Based on DATABASE_DESIGN.md

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Organizations
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Memberships (Tenant Scoped)
CREATE TABLE memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, organization_id)
);

-- 4. Documents (Tenant Scoped)
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES users(id),
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size BIGINT NOT NULL CHECK (file_size > 0),
    storage_key TEXT NOT NULL,
    checksum TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'uploaded', 'processing', 'ready', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

-- 5. Document Processing Jobs (Tenant Scoped)
CREATE TABLE document_processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stage VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed', 'success')),
    attempts INT NOT NULL DEFAULT 0,
    error_log TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- 6. Conversations (Tenant Scoped)
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    title VARCHAR(255) DEFAULT 'New Chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

-- 7. Messages (Tenant Scoped)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id), -- NULL for assistant
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Citations (Tenant Scoped)
CREATE TABLE citations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    page_number INT,
    chunk_index INT NOT NULL,
    relevance_score FLOAT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Audit Logs (Tenant Scoped)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) IMPLEMENTATION
-- =============================================================================

-- Enable and FORCE RLS on all tenant-scoped tables
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_processing_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE citations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- Define the RLS Policy
-- All tenant tables use the same variable: app.current_tenant
CREATE POLICY tenant_isolation_policy ON memberships
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON documents
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON document_processing_jobs
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON conversations
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON messages
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON citations
    USING (organization_id = current_setting('app.current_tenant')::UUID);

CREATE POLICY tenant_isolation_policy ON audit_logs
    USING (organization_id = current_setting('app.current_tenant')::UUID);

-- -----------------------------------------------------------------------------
-- Platform Admin Role
-- -----------------------------------------------------------------------------

-- Create a separate role for platform admins that bypasses RLS
-- Note: This part usually requires superuser privileges to execute.
-- In a real deployment, this would be handled by the DB migration tool.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'platform_admin_role') THEN
        CREATE ROLE platform_admin_role WITH BYPASSRLS;
    END IF;
END
$$;

-- =============================================================================
-- INDEXING STRATEGY
-- =============================================================================

CREATE INDEX idx_orgs_slug ON organizations(slug);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_memberships_user_org ON memberships(user_id, organization_id);
CREATE INDEX idx_docs_org_status ON documents(organization_id, status);
CREATE INDEX idx_docs_checksum ON documents(checksum);
CREATE INDEX idx_convs_org_user ON conversations(organization_id, user_id);
CREATE INDEX idx_msgs_conv_created ON messages(conversation_id, created_at);
CREATE INDEX idx_citations_msg ON citations(message_id);
CREATE INDEX idx_audit_org_created ON audit_logs(organization_id, created_at);
