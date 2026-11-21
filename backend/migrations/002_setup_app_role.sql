-- Create application role idempotently
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_app') THEN
    CREATE ROLE documind_app WITH LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

-- Grant permissions
GRANT USAGE ON SCHEMA public TO documind_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO documind_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO documind_app;

-- Ensure future tables also get permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO documind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO documind_app;

