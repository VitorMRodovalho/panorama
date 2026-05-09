-- Pre-migration bootstrap for Postgres targets where
-- infra/docker/postgres-init.sql NEVER runs — i.e. managed Postgres
-- (Supabase, Neon, RDS, …). Idempotent: safe to re-run; safe to run
-- on self-hosted too (the IF NOT EXISTS guards mean it's a no-op
-- there because postgres-init already created the roles).
--
-- Apply BEFORE `prisma migrate deploy` against a fresh managed-PG
-- database. Run as the privileged user (Supabase: `postgres` via the
-- DIRECT connection on port 5432, NOT the pooler).
--
-- Surfaced during 2026-05-09 staging bring-up: migration 0011 +
-- subsequent ones GRANT TO `panorama_app` / `panorama_super_admin`,
-- which only existed on self-hosted.

-- 1. Roles. NOLOGIN — they're not authentication identities; they're
--    permission containers that the connecting user (e.g. `postgres`
--    on Supabase) `SET ROLE`s into per-request, matching the
--    ADR-0015 v2 two-client pattern (privileged + appClient).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'panorama_app') THEN
    CREATE ROLE panorama_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'panorama_super_admin') THEN
    CREATE ROLE panorama_super_admin NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- 2. Grant the connecting user (postgres on Supabase, panorama on
--    self-hosted) membership of both roles so SET ROLE can switch
--    in. Required by PrismaService's two-client design and by the
--    runbook's "SET LOCAL ROLE panorama_app" verification step.
DO $$
BEGIN
  EXECUTE format('GRANT panorama_app TO %I', current_user);
  EXECUTE format('GRANT panorama_super_admin TO %I', current_user);
END $$;

-- 3. CONNECT on the current database — parametric so this script is
--    portable. Self-hosted = `panorama`; Supabase = `postgres`.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO panorama_app, panorama_super_admin',
    current_database()
  );
END $$;

-- 4. Schema USAGE on public so the GRANTs in subsequent migrations
--    (SELECT/INSERT/UPDATE on tables) actually take effect.
GRANT USAGE ON SCHEMA public TO panorama_app, panorama_super_admin;

-- 5. Extensions migrations rely on. Supabase usually has these
--    pre-installed, but `IF NOT EXISTS` makes this a no-op when
--    they're already present.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;
