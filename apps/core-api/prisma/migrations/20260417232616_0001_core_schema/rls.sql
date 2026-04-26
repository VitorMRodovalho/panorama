-- Row-Level Security policies for the 0001 core schema.
-- Applied separately from Prisma's migration.sql because Prisma cannot
-- express RLS. Run by the migration runner AFTER migration.sql succeeds.
--
-- The session GUC `app.current_tenant` is set per transaction by
-- TenantMiddleware (see apps/core-api/src/modules/tenant/). The policies
-- below key off that setting.
--
-- Roles:
--   * panorama_app — application runtime role. NOBYPASSRLS.
--   * panorama_super_admin — operators / backups / migrations. BYPASSRLS.
-- Both are provisioned by infra/docker/postgres-init.sql (and the equivalent
-- Helm/Terraform bootstrap in prod).

BEGIN;

-- --------------------------------------------------------------------
-- Helper: current_tenant() returns NULL if the GUC is unset or empty,
-- so we can treat "no tenant context" as "deny" for scoped tables.
--
-- GUC namespace was migrated from `app.*` → `panorama.*` by ADR-0015 v2
-- (migration 0013). The function body below reflects the CURRENT
-- namespace. We update this 0001/rls.sql in-place rather than letting
-- 0013/migration.sql's CREATE OR REPLACE be the only authority,
-- because the CI workflow re-applies rls.sql files on every job —
-- if 0001/rls.sql kept the old `app.current_tenant` body, every CI
-- run would silently overwrite 0013's correction and the helper
-- would return NULL inside transactions that set the new GUC.
-- rls.sql files are NOT Prisma-migration-tracked; they are managed
-- project-level fixtures, so amending this body is safe.
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
  'Tenant context for the current transaction. Set via SET LOCAL panorama.current_tenant = ''<uuid>'' (PrismaService.runInTenant). Returns NULL when unset — denies access to tenant-scoped tables. GUC namespace migrated from app.* per ADR-0015 v2.';

-- --------------------------------------------------------------------
-- Grants. The app role owns no tables; the schema owner (panorama) does.
-- Grant only what the app needs.
-- --------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO panorama_app, panorama_super_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO panorama_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO panorama_app;

-- Super admin needs the same DML privileges so it can act across tenants.
-- RLS is bypassed at the role level (BYPASSRLS), but table-level privileges
-- still apply. Without these grants the super admin cannot touch the tables
-- at all (e.g. for migrations run via the application connection, backups,
-- or cross-tenant dashboards).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO panorama_super_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO panorama_super_admin;

-- Grant the app role membership in super_admin so PrismaService.runAsSuperAdmin
-- can promote the session role inside a transaction via `SET LOCAL ROLE
-- panorama_super_admin`. Required for auth's cross-tenant membership lookups,
-- backups, and migrations that need to read/write across RLS boundaries.
GRANT panorama_super_admin TO panorama_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO panorama_app, panorama_super_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO panorama_app, panorama_super_admin;

-- --------------------------------------------------------------------
-- Tenant-scoped tables.
-- Every table that has a `tenantId` column gets:
--   * RLS enabled
--   * A policy that matches `tenantId = panorama_current_tenant()`
--   * The policy applies to the app role; panorama_super_admin has BYPASSRLS
--     at the role level so doesn't need a carve-out here.
-- --------------------------------------------------------------------

ALTER TABLE tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants               FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships    FORCE  ROW LEVEL SECURITY;
ALTER TABLE categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories            FORCE  ROW LEVEL SECURITY;
ALTER TABLE manufacturers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturers         FORCE  ROW LEVEL SECURITY;
ALTER TABLE asset_models          ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_models          FORCE  ROW LEVEL SECURITY;
ALTER TABLE assets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets                FORCE  ROW LEVEL SECURITY;
ALTER TABLE reservations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations          FORCE  ROW LEVEL SECURITY;

-- tenants: self-scoping — a request with tenantId=X can only see tenant X
CREATE POLICY tenants_tenant_isolation ON tenants
    FOR ALL TO panorama_app
    USING (id = panorama_current_tenant())
    WITH CHECK (id = panorama_current_tenant());

-- Generic predicate for every other table with a `tenantId` column.
CREATE POLICY tenant_memberships_tenant_isolation ON tenant_memberships
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY categories_tenant_isolation ON categories
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY manufacturers_tenant_isolation ON manufacturers
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY asset_models_tenant_isolation ON asset_models
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY assets_tenant_isolation ON assets
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY reservations_tenant_isolation ON reservations
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- --------------------------------------------------------------------
-- Global tables (no tenantId) — keep RLS OFF deliberately.
--   * users / auth_identities are global (a human can belong to many tenants)
--   * audit_events optionally have tenantId but also log cross-tenant actions
--   * system_settings is cluster-wide
-- Access control for these happens at the application layer.
-- --------------------------------------------------------------------

-- audit_events has an optional tenantId. We allow reading only the caller's
-- own tenant rows, OR NULL-tenant rows (cluster-wide events) which are handled
-- by the super admin path.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY audit_events_tenant_read ON audit_events
    FOR SELECT TO panorama_app
    USING ("tenantId" IS NULL OR "tenantId" = panorama_current_tenant());

-- Writes to audit_events always go through the app; inserts must carry either
-- the matching tenantId or NULL (system events).
CREATE POLICY audit_events_tenant_write ON audit_events
    FOR INSERT TO panorama_app
    WITH CHECK ("tenantId" IS NULL OR "tenantId" = panorama_current_tenant());

-- Audit rows are append-only. No UPDATE/DELETE policy = no UPDATE/DELETE.

COMMIT;
