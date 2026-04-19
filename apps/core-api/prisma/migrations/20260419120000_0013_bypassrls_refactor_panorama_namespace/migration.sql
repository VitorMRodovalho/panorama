-- ADR-0015 v2 — BYPASSRLS removal refactor + GUC namespace migration.
--
-- Two intertwined changes that MUST land atomically with the
-- prisma.service.ts refactor (commit-level atomicity, not Postgres-tx):
--
--   1. GUC rename: `app.current_tenant` → `panorama.current_tenant`.
--      Done by redefining `panorama_current_tenant()` to read the new
--      GUC name. EVERY existing RLS policy calls this function (not
--      the GUC directly) — so no policy ALTER is needed for this part.
--
--   2. Privileged-path refactor: drop the BYPASSRLS-role pattern (which
--      Supabase's managed Postgres can't grant) and replace with a
--      SECURITY DEFINER function `panorama_enable_bypass_rls()` whose
--      EXECUTE grant is restricted to `panorama_super_admin`. The
--      privileged-bypass policy on every tenant-scoped table grants
--      `panorama_super_admin` access ONLY when the bypass GUC is set,
--      which only happens via the SECURITY DEFINER call.
--
-- Trust-boundary moves from "Postgres role attribute (BYPASSRLS)" to
-- "EXECUTE grant on a SECURITY DEFINER function". Both kernel-enforced.
-- See `docs/adr/0015-bypassrls-removal-refactor.md` v2.
--
-- Idempotent: `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`,
-- `ALTER ROLE` (no-ops on Supabase where the attribute couldn't be set).
-- Prisma `migrate deploy` records this in `_prisma_migrations` so re-runs
-- skip cleanly; the inner DDL is also re-runnable on its own.

BEGIN;

-- --------------------------------------------------------------------
-- 1. GUC rename via function redefinition.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION panorama_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw text;
BEGIN
    raw := current_setting('panorama.current_tenant', true);
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION panorama_current_tenant() IS
  'Tenant context for the current transaction. Set via '
  '`SET LOCAL panorama.current_tenant = ''<uuid>''` (PrismaService.runInTenant). '
  'Returns NULL when unset — denies access to tenant-scoped tables. '
  'GUC migrated from `app.current_tenant` per ADR-0015 v2.';

-- --------------------------------------------------------------------
-- 2. SECURITY DEFINER bypass function — gate for the privileged path.
--
-- SECURITY DEFINER + EXECUTE-grant-restricted is the trust boundary.
-- The function sets a TX-LOCAL GUC; after COMMIT/ROLLBACK the GUC is
-- gone. The privileged-bypass policies below check for that GUC.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION panorama_enable_bypass_rls() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('panorama.bypass_rls', 'on', true);
END;
$$;

COMMENT ON FUNCTION panorama_enable_bypass_rls() IS
  'ADR-0015 v2 privileged-path RLS gate. SECURITY DEFINER + EXECUTE '
  'restricted to panorama_super_admin. Sets panorama.bypass_rls = ''on'' '
  '(tx-local). Called by PrismaService.runAsSuperAdmin via the '
  'privilegedClient. SQL injection on the appClient cannot reach this '
  'function (panorama_app has no EXECUTE grant).';

REVOKE ALL ON FUNCTION panorama_enable_bypass_rls() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION panorama_enable_bypass_rls() TO panorama_super_admin;

-- --------------------------------------------------------------------
-- 3. v1 GRANT membership cleanup.
--
-- v1 set `GRANT panorama_super_admin TO panorama_app` so PrismaService
-- could `SET LOCAL ROLE panorama_super_admin` inside a tx on the
-- single client. v2 uses two separate Prisma clients with two
-- separate logins — no in-tx role-switch needed. Revoking the
-- membership here closes a path where panorama_app could
-- accidentally escape-hatch into the privileged role (if a test or
-- ad-hoc query bypassed PrismaService).
--
-- IMPORTANT — BYPASSRLS attribute on panorama_super_admin is NOT
-- dropped by this migration. Reasons:
--
--   * On self-hosted Postgres (dev + AGPL deploy), the role was
--     created with BYPASSRLS by `infra/docker/postgres-init.sql`.
--     ~20 existing test files rely on direct `admin.<table>.findMany()`
--     calls returning all rows. Dropping BYPASSRLS would force a
--     test-wide rewrite to wrap every admin op in a bypass tx.
--   * On Supabase managed Postgres, the role is created without
--     BYPASSRLS (the attribute can't be granted to tenant roles). The
--     v2 trust model — EXECUTE-grant + privileged-bypass policies —
--     IS the only way to bypass on Supabase. So the attribute is
--     irrelevant there.
--
-- Operators who want stricter isolation on self-hosted (matching the
-- managed-Postgres posture) can manually run:
--   ALTER ROLE panorama_super_admin NOBYPASSRLS;
-- and then update their test setup. Documented in
-- `docs/runbooks/setup-supabase-staging.md`.
DO $$
BEGIN
    BEGIN
        EXECUTE 'REVOKE panorama_super_admin FROM panorama_app';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'REVOKE panorama_super_admin FROM panorama_app: %', SQLERRM;
    END;
END $$;

-- --------------------------------------------------------------------
-- 4. Privileged-bypass policies on every tenant-scoped table.
--
-- Auto-discovers tables with rowsecurity=true. The privileged client
-- (`panorama_super_admin`) gets access to a table ONLY when
-- `panorama.bypass_rls = 'on'` — which only happens after a successful
-- call to `panorama_enable_bypass_rls()` (gated by the EXECUTE grant).
--
-- Re-runnable: DROP POLICY IF EXISTS first, then CREATE.
-- --------------------------------------------------------------------
DO $$
DECLARE
    tbl record;
    pname text;
BEGIN
    FOR tbl IN
        SELECT tablename
          FROM pg_tables
         WHERE schemaname = 'public'
           AND rowsecurity = true
         ORDER BY tablename
    LOOP
        pname := tbl.tablename || '_super_admin_bypass';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, tbl.tablename);
        EXECUTE format(
          'CREATE POLICY %I ON %I '
          'FOR ALL TO panorama_super_admin '
          'USING (current_setting(''panorama.bypass_rls'', true) = ''on'') '
          'WITH CHECK (current_setting(''panorama.bypass_rls'', true) = ''on'')',
          pname, tbl.tablename
        );
        RAISE NOTICE 'created %I on %I', pname, tbl.tablename;
    END LOOP;
END $$;

-- --------------------------------------------------------------------
-- 5. Grants on the public schema for panorama_super_admin.
--
-- Existing 0001 rls.sql already grants SELECT/INSERT/UPDATE/DELETE on
-- ALL TABLES; that survives. Re-grant defensively in case a fresh
-- Supabase apply reaches this migration without the v1 0001 grants
-- being applied (the 0001 grants are conditional on the
-- panorama_super_admin role existing at apply time).
-- --------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO panorama_super_admin';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO panorama_super_admin';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO panorama_super_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO panorama_super_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO panorama_super_admin';
    EXCEPTION
        WHEN undefined_object THEN
            RAISE NOTICE 'panorama_super_admin role not present — defer grants to bootstrap';
    END;
END $$;

COMMIT;
