-- Panorama Postgres bootstrap.
-- Idempotent — safe to run on a fresh container (dev's initdb hook) OR on
-- an existing DB (CI bootstrap step). Each statement guards against the
-- "already exists" case so re-runs don't fail.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Application runtime role: no BYPASSRLS, forced to go through policies.
-- RLS policies reference `app.current_tenant` session GUC.
DO $$
BEGIN
    CREATE ROLE panorama_app LOGIN PASSWORD 'panorama' NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
    ALTER ROLE panorama_app WITH LOGIN PASSWORD 'panorama' NOBYPASSRLS;
END $$;
GRANT CONNECT ON DATABASE panorama TO panorama_app;

-- Super admin role: BYPASSRLS for operator actions (backups, migrations,
-- cross-tenant dashboards). Never used for regular request handling.
DO $$
BEGIN
    CREATE ROLE panorama_super_admin LOGIN PASSWORD 'panorama' BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
    ALTER ROLE panorama_super_admin WITH LOGIN PASSWORD 'panorama' BYPASSRLS;
END $$;
GRANT CONNECT ON DATABASE panorama TO panorama_super_admin;

-- System schema reserved for cluster-wide settings (not tenant-scoped).
CREATE SCHEMA IF NOT EXISTS panorama_system AUTHORIZATION panorama;
GRANT USAGE ON SCHEMA panorama_system TO panorama_app;
