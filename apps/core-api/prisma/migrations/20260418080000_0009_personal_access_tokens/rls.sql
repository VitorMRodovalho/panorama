-- Row-Level Security for the personal_access_tokens table (migration 0009).
-- Applied after migration.sql — same pattern as 0001/rls.sql.
--
-- Tokens are tenant-scoped (ADR-0010): the `tenantId` column drives
-- isolation via the `app.current_tenant` session GUC set by
-- TenantMiddleware. The PAT auth guard runs at `runAsSuperAdmin` for
-- the lookup-by-tokenHash path (no tenant context yet — the token IS
-- what selects the tenant), then switches to `runInTenant` once the
-- actor is resolved.
--
-- The issuance / revocation endpoints run inside an authenticated
-- session, i.e. under `runInTenant(actor.tenantId, ...)`, so the RLS
-- policy below is sufficient to prevent a tenant-A admin from reading
-- or mutating tenant-B tokens.
--
-- Reminder (panorama_tooling_gotchas.md): `prisma migrate dev` wipes
-- and recreates the shadow DB and drops hand-written grants / RLS from
-- the main DB too. CI + the docker dev loop re-apply every migration's
-- rls.sql after `migrate deploy`; local devs should run the one-liner
-- from the gotchas memo whenever they invoke migrate dev.

BEGIN;

ALTER TABLE personal_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_access_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY personal_access_tokens_tenant_isolation ON personal_access_tokens
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- Default privileges in 0001/rls.sql already grant SELECT / INSERT /
-- UPDATE / DELETE on new tables to panorama_app and
-- panorama_super_admin, so no additional GRANTs are needed.

COMMIT;
