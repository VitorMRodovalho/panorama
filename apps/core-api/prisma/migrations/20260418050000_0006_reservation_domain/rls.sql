-- Row-Level Security for `blackout_slots` (migration 0006).
-- Applied after migration.sql — same pattern as the other tenant-
-- scoped tables. Blackouts are tenant-scoped; `panorama_app` sees
-- only its own tenant via the `app.current_tenant` session GUC.
--
-- No RLS change on `reservations` — the policy already covers the
-- new columns because it's a table-level FOR ALL filter on
-- `"tenantId" = panorama_current_tenant()`. The foreign keys we
-- added point at global tables (`users`) which have no RLS, so no
-- adjacent policy change is needed either.

BEGIN;

ALTER TABLE blackout_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE blackout_slots FORCE  ROW LEVEL SECURITY;

CREATE POLICY blackout_slots_tenant_isolation ON blackout_slots
    FOR ALL TO panorama_app
    USING ("tenantId" = panorama_current_tenant())
    WITH CHECK ("tenantId" = panorama_current_tenant());

-- Default privileges from 0001/rls.sql already cover the new table
-- with SELECT / INSERT / UPDATE / DELETE for panorama_app and
-- panorama_super_admin, so no additional GRANTs are required here.

COMMIT;
