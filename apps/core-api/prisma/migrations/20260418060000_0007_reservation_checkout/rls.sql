-- Migration 0007 adds columns to an existing table; no RLS change
-- required. The existing reservations_tenant_isolation policy
-- (FOR ALL with tenantId = current_tenant) already covers the new
-- columns, and the new FKs point at the global `users` table which
-- has no RLS.
SELECT 1;
