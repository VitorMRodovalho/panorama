-- Row-Level Security for the inspection tables (migration 0012, ADR-0012).
--
-- Mandated runInTenant contract: every query against inspection_*
-- tables MUST run under PrismaService.runInTenant(tenantId, ...). The
-- inspection module is architecturally forbidden from calling
-- runAsSuperAdmin (AuditService.record is the single exception — it
-- intentionally runs outside tenant context to preserve the audit
-- chain on rollback). RLS is the LOAD-BEARING isolation layer;
-- service-level tenantId asserts + storage-key prefix checks are
-- belt-and-braces.
--
-- Every table pairs ENABLE with FORCE so a maintenance script
-- running as the table owner (panorama_super_admin) WITHOUT an
-- explicit RESET ROLE still has the policy applied. ADR-0011 and
-- migration 0001 set this convention.

BEGIN;

ALTER TABLE "inspection_templates"      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "inspection_templates"      FORCE   ROW LEVEL SECURITY;
ALTER TABLE "inspection_template_items" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "inspection_template_items" FORCE   ROW LEVEL SECURITY;
ALTER TABLE "inspections"               ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "inspections"               FORCE   ROW LEVEL SECURITY;
ALTER TABLE "inspection_responses"      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "inspection_responses"      FORCE   ROW LEVEL SECURITY;
ALTER TABLE "inspection_photos"         ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "inspection_photos"         FORCE   ROW LEVEL SECURITY;

CREATE POLICY inspection_templates_tenant_isolation ON "inspection_templates"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY inspection_template_items_tenant_isolation ON "inspection_template_items"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY inspections_tenant_isolation ON "inspections"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY inspection_responses_tenant_isolation ON "inspection_responses"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

CREATE POLICY inspection_photos_tenant_isolation ON "inspection_photos"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- Default privileges in 0001/rls.sql grant SELECT/INSERT/UPDATE/DELETE
-- on new tables to panorama_app + panorama_super_admin automatically,
-- so no additional GRANTs here.

COMMIT;
