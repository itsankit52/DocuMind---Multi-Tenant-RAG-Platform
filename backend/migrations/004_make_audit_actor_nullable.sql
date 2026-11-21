-- Migration 004: Allow nullable actor_id on audit_logs for system/worker-generated events
-- The FK constraint (audit_logs_actor_id_fkey -> users(id)) is preserved;
-- NULL values simply bypass FK validation per SQL standard semantics.

ALTER TABLE audit_logs ALTER COLUMN actor_id DROP NOT NULL;
