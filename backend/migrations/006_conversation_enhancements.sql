-- Migration 006: Conversation Management Enhancements
-- Adds columns required for Step 9: Persistent Chat + Conversation Management
--
-- The core tables (conversations, messages, citations) already exist from migration 001.
-- This migration safely extends them with:
--   1. messages.idempotency_key   — prevent duplicate assistant responses
--   2. messages.metadata          — extensible JSONB for future per-message data
--   3. citations.chunk_id         — UUID reference to the actual document_chunks row
--   4. citations.document_name    — denormalised filename for fast citation display
--   5. citations.created_at       — timestamp for citation ordering / auditing
--   6. Additional performance indexes for conversation queries

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. messages: idempotency_key (UNIQUE, nullable — only set on user messages)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'idempotency_key'
    ) THEN
        ALTER TABLE messages ADD COLUMN idempotency_key VARCHAR(128);
    END IF;
END $$;

-- Partial unique index: only enforce uniqueness when idempotency_key is non-null
-- Scoped per conversation to prevent cross-conversation key collisions
CREATE UNIQUE INDEX IF NOT EXISTS uidx_messages_idempotency
    ON messages (conversation_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. messages: metadata JSONB for extensible per-message data
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'metadata'
    ) THEN
        ALTER TABLE messages ADD COLUMN metadata JSONB DEFAULT '{}';
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. citations: chunk_id UUID (FK to document_chunks, nullable for resilience)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'citations' AND column_name = 'chunk_id'
    ) THEN
        ALTER TABLE citations ADD COLUMN chunk_id UUID REFERENCES document_chunks(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. citations: document_name — denormalised for fast display without a JOIN
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'citations' AND column_name = 'document_name'
    ) THEN
        ALTER TABLE citations ADD COLUMN document_name VARCHAR(255);
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. citations: created_at timestamp
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'citations' AND column_name = 'created_at'
    ) THEN
        ALTER TABLE citations ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Additional performance indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Conversations: ordering by updated_at within a tenant (list endpoint)
CREATE INDEX IF NOT EXISTS idx_conversations_org_updated
    ON conversations (organization_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- Conversations: quick lookup of non-deleted conversations by creator
CREATE INDEX IF NOT EXISTS idx_conversations_user_org
    ON conversations (user_id, organization_id)
    WHERE deleted_at IS NULL;

-- Messages: org + conversation scope (tenant-aware message listing)
CREATE INDEX IF NOT EXISTS idx_messages_org_conv
    ON messages (organization_id, conversation_id, created_at);

-- Citations: org-level index (cross-conversation citation queries)
CREATE INDEX IF NOT EXISTS idx_citations_org
    ON citations (organization_id);

-- Citations: chunk_id lookup (optional reverse-lookup from chunk to citations)
CREATE INDEX IF NOT EXISTS idx_citations_chunk_id
    ON citations (chunk_id)
    WHERE chunk_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Ensure documind_app role has privileges on all affected tables
--    (ALTER DEFAULT PRIVILEGES from migration 002 covers new tables, but
--     we explicitly grant here for safety since these tables already exist)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_app') THEN
        GRANT ALL PRIVILEGES ON TABLE conversations TO documind_app;
        GRANT ALL PRIVILEGES ON TABLE messages TO documind_app;
        GRANT ALL PRIVILEGES ON TABLE citations TO documind_app;
    END IF;
END $$;
