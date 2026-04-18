-- Migration 0005 — Tenant Owner enforcement (ADR-0007).
--
-- Adds a BEFORE UPDATE / DELETE trigger on tenant_memberships that
-- refuses any operation which would drop a tenant's count of active
-- Owners to zero. The count is scoped to the row being affected —
-- for UPDATE the check ignores the row itself, so an Owner can be
-- updated in-place as long as they remain an active Owner OR another
-- Owner already exists.
--
-- INSERT is intentionally not guarded: an insert can only increase
-- the Owner count (or be irrelevant for non-owner rows), so it cannot
-- violate the "≥1 Owner" invariant on its own.
--
-- The trigger complements the service-layer guards in
-- TenantAdminService; DB-side enforcement is defence in depth that
-- survives even a misbehaving privileged client (super-admin CLI,
-- ad-hoc psql session) bypassing the service.
--
-- Raising a specific SQLSTATE (45000 = user-defined exception) with
-- a stable message code lets the service layer map the error to a
-- friendly 409 Conflict without parsing English text.

CREATE OR REPLACE FUNCTION enforce_at_least_one_owner()
RETURNS trigger AS $$
DECLARE
    remaining int;
BEGIN
    SELECT COUNT(*) INTO remaining
      FROM tenant_memberships
     WHERE "tenantId" = COALESCE(OLD."tenantId", NEW."tenantId")
       AND "role" = 'owner'
       AND "status" = 'active'
       AND id <> COALESCE(OLD.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF remaining = 0
       AND (
            TG_OP = 'DELETE'
            OR NEW."role"   <> 'owner'
            OR NEW."status" <> 'active'
       )
    THEN
        RAISE EXCEPTION 'TENANT_MUST_HAVE_AT_LEAST_ONE_OWNER'
              USING ERRCODE = '45000';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_at_least_one_owner_trigger ON tenant_memberships;
CREATE TRIGGER enforce_at_least_one_owner_trigger
    BEFORE UPDATE OR DELETE ON tenant_memberships
    FOR EACH ROW EXECUTE FUNCTION enforce_at_least_one_owner();
