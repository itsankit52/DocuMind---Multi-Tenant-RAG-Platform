-- Migration 005: Add Embedding Metadata to document_chunks

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_chunks' AND column_name='embedded_at') THEN
        ALTER TABLE document_chunks ADD COLUMN embedded_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='document_chunks' AND column_name='embedding_error') THEN
        ALTER TABLE document_chunks ADD COLUMN embedding_error TEXT;
    END IF;
END $$;
