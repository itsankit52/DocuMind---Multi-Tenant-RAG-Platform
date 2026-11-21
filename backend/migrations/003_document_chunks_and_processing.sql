-- Migration 003: Document Chunks, Processing Jobs Enhancements, and Outbox Events

-- 1. Document Chunks Table
CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    page_start INT,
    page_end INT,
    character_count INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chunk_index)
);

-- Indexing for Document Chunks
CREATE INDEX IF NOT EXISTS idx_chunks_org_doc ON document_chunks(organization_id, document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_index ON document_chunks(document_id, chunk_index);

-- Row-Level Security on Document Chunks
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_document_chunks ON document_chunks;
CREATE POLICY tenant_isolation_document_chunks ON document_chunks
    USING (organization_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- 2. Enhance document_processing_jobs
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_processing_jobs' AND column_name='max_attempts') THEN
        ALTER TABLE document_processing_jobs ADD COLUMN max_attempts INT NOT NULL DEFAULT 3;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_processing_jobs' AND column_name='created_at') THEN
        ALTER TABLE document_processing_jobs ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_processing_jobs' AND column_name='updated_at') THEN
        ALTER TABLE document_processing_jobs ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_processing_jobs' AND column_name='locked_at') THEN
        ALTER TABLE document_processing_jobs ADD COLUMN locked_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_processing_jobs' AND column_name='worker_id') THEN
        ALTER TABLE document_processing_jobs ADD COLUMN worker_id VARCHAR(100);
    END IF;
END $$;

-- Update status check constraint on document_processing_jobs
ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_status_check;
ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_status_check
    CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'success', 'failed', 'retrying'));

CREATE INDEX IF NOT EXISTS idx_doc_jobs_doc_status ON document_processing_jobs(document_id, status);
CREATE INDEX IF NOT EXISTS idx_doc_jobs_org_status ON document_processing_jobs(organization_id, status);

-- 3. Outbox Events Table
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id);

-- 4. Grant Permissions to documind_app role
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_app') THEN
        GRANT ALL PRIVILEGES ON TABLE document_chunks TO documind_app;
        GRANT ALL PRIVILEGES ON TABLE document_processing_jobs TO documind_app;
        GRANT ALL PRIVILEGES ON TABLE outbox_events TO documind_app;
    END IF;
END $$;
