-- Row-Level Security for notification_events (migration 0011, ADR-0011).
--
-- Tenant-scoped writes from domain services go through runInTenant,
-- so the panorama_app role must see its own tenant's rows and nothing
-- else. Cluster-wide events (tenantId IS NULL) are legitimately
-- visible to every in-tenant read — they describe system-level
-- notifications. Cross-tenant pooling (the dispatcher) runs as
-- panorama_notification_dispatcher which bypasses RLS via
-- BYPASSRLS... wait — NO. The dispatcher role explicitly DOES NOT
-- have BYPASSRLS; it has narrow grants. Cross-tenant visibility for
-- the dispatcher comes from reading without any `app.current_tenant`
-- GUC set, which — combined with our policy's OR tenantId IS NULL
-- clause — would fail closed. Instead the dispatcher walks tenants
-- explicitly OR binds to the panorama_super_admin role briefly when
-- polling. The ADR defers that to the dispatcher implementation
-- (step 4).
--
-- For 0.2 this RLS is defensive: enables policy enforcement; the
-- dispatcher-level cross-tenant access pattern is finalised when the
-- dispatcher itself lands.

BEGIN;

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_events_tenant_isolation ON notification_events
    FOR ALL TO panorama_app
    USING (
        "tenantId" = panorama_current_tenant()
        OR "tenantId" IS NULL
    )
    WITH CHECK (
        "tenantId" = panorama_current_tenant()
        OR "tenantId" IS NULL
    );

-- Default privileges in 0001/rls.sql grant SELECT/INSERT/UPDATE/DELETE
-- on new tables to panorama_app + panorama_super_admin automatically,
-- so no additional GRANTs here beyond those. The narrow dispatcher
-- role's grants are in migration.sql because they reference specific
-- tables.

COMMIT;
