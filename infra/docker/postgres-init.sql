-- Panorama Postgres bootstrap (dev).
-- Runs once on first container start, before migrations.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Least-privilege role used by the application at runtime. Owns no tables;
-- schema owner (panorama) grants SELECT/INSERT/UPDATE/DELETE to it on
-- migration. The RLS policies reference current_setting('app.current_tenant').
CREATE ROLE panorama_app LOGIN PASSWORD 'panorama' NOBYPASSRLS;
GRANT CONNECT ON DATABASE panorama TO panorama_app;

-- Super admin DB role — used by backups, migrations, and super-admin dashboards.
-- Explicit BYPASSRLS so operator actions can see cross-tenant rows. Never used
-- for regular request handling.
CREATE ROLE panorama_super_admin LOGIN PASSWORD 'panorama' BYPASSRLS;
GRANT CONNECT ON DATABASE panorama TO panorama_super_admin;

-- System schema holds cluster-wide settings that are NOT tenant-scoped.
CREATE SCHEMA IF NOT EXISTS panorama_system AUTHORIZATION panorama;
GRANT USAGE ON SCHEMA panorama_system TO panorama_app;
