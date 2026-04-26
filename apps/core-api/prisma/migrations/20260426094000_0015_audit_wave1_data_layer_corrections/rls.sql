-- DATA-02 / SEC-06 / #30 — replace migration 0014's raw GUC casts
-- with the panorama_current_tenant() helper, matching every other
-- tenant-scoped table.
--
-- The raw cast `current_setting('panorama.current_tenant', true)::uuid`
-- throws on malformed GUC values and returns the literal string
-- "undefined" coercion errors when the GUC is set to something
-- non-UUID (or unset on a Postgres version that returns ''); the
-- helper catches `invalid_text_representation` and returns NULL,
-- which RLS interprets as deny.
--
-- This file's policies REPLACE the originals from migration 0014's
-- rls.sql. We DROP + CREATE rather than ALTER POLICY because the
-- USING / WITH CHECK predicates need to be rewritten wholesale,
-- and policy semantics in Postgres do not support partial ALTERs.
--
-- The super_admin_bypass policies are NOT re-issued — they predicate
-- on `panorama.bypass_rls = 'on'` (a string compare on a different
-- GUC), which has no UUID-cast surface to fix.

-- Wrap the DROP+CREATE pair in an explicit transaction so the
-- "policy briefly missing" window is bounded by the txn commit.
-- FORCE RLS makes the no-policy interim deny-all on panorama_app
-- (fail-safe direction), but explicit BEGIN/COMMIT keeps it tight.
BEGIN;

-- ---------------------------------------------------------------
-- asset_maintenances
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS asset_maintenances_tenant_isolation ON "asset_maintenances";
CREATE POLICY asset_maintenances_tenant_isolation ON "asset_maintenances"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- ---------------------------------------------------------------
-- maintenance_photos
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS maintenance_photos_tenant_isolation ON "maintenance_photos";
CREATE POLICY maintenance_photos_tenant_isolation ON "maintenance_photos"
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

COMMIT;
