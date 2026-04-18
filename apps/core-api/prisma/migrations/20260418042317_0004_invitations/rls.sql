-- Row-Level Security for the invitations table (migration 0004).
-- Applied after migration.sql — same pattern as 0001/rls.sql.
--
-- Invitations are tenant-scoped: the `tenantId` column drives isolation
-- via the `app.current_tenant` session GUC set by TenantMiddleware.
--
-- Reminder (see panorama_tooling_gotchas.md): `prisma migrate dev`
-- wipes and recreates the shadow DB and drops hand-written grants /
-- RLS from the main DB too. CI + the docker dev loop re-apply every
-- migration's rls.sql after `migrate deploy`; local devs should run
-- the one-liner from the gotchas memo whenever they invoke migrate dev.

BEGIN;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY invitations_tenant_isolation ON invitations
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- Default privileges defined in 0001/rls.sql already grant SELECT /
-- INSERT / UPDATE / DELETE on new tables to panorama_app and
-- panorama_super_admin, so no additional GRANTs are needed here.

COMMIT;
