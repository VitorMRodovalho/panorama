-- Migration 0010 — exclusion constraint on reservations. No RLS surface
-- change. The existing `reservations_tenant_isolation` policy
-- (migration 0006) already scopes every read + write by tenantId; the
-- new exclusion constraint is additive at the DB-index layer and does
-- not bypass RLS.
SELECT 1;
