-- RLS for migration 0014 — Asset maintenance flow (ADR-0016).
--
-- Two new tables, two policies each:
--   1. Tenant isolation (panorama_app role, USING + WITH CHECK
--      against panorama.current_tenant GUC).
--   2. Privileged bypass (panorama_super_admin role, gated by
--      panorama.bypass_rls = 'on'). Per-table policy is required
--      because migration 0013's DO-block sweep is one-shot and
--      does NOT auto-fire on tables landing post-0013 (see
--      data-architect blocker B3).
--
-- Pairs ENABLE + FORCE so policy bypass via table owner / superuser
-- is also blocked unless explicitly elevated. Mirrors the ADR-0012
-- §5 four-layer contract for maintenance photos and adds the cross-
-- tenant FK trigger as the fifth layer (see migration.sql §8).

-- ---------------------------------------------------------------
-- asset_maintenances
-- ---------------------------------------------------------------
ALTER TABLE "asset_maintenances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_maintenances" FORCE ROW LEVEL SECURITY;

CREATE POLICY asset_maintenances_tenant_isolation ON "asset_maintenances"
    FOR ALL TO panorama_app
    USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);

CREATE POLICY asset_maintenances_super_admin_bypass ON "asset_maintenances"
    FOR ALL TO panorama_super_admin
    USING (current_setting('panorama.bypass_rls', true) = 'on')
    WITH CHECK (current_setting('panorama.bypass_rls', true) = 'on');

-- ---------------------------------------------------------------
-- maintenance_photos
-- ---------------------------------------------------------------
ALTER TABLE "maintenance_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_photos" FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_photos_tenant_isolation ON "maintenance_photos"
    FOR ALL TO panorama_app
    USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);

CREATE POLICY maintenance_photos_super_admin_bypass ON "maintenance_photos"
    FOR ALL TO panorama_super_admin
    USING (current_setting('panorama.bypass_rls', true) = 'on')
    WITH CHECK (current_setting('panorama.bypass_rls', true) = 'on');
