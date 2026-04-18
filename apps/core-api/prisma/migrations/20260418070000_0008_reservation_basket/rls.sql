-- Migration 0008 adds one nullable column + one index; no RLS change.
-- Existing reservations_tenant_isolation policy covers the new column
-- because it filters FOR ALL on tenantId.
SELECT 1;
