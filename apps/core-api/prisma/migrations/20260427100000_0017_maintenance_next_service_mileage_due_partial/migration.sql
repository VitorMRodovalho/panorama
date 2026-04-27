-- Migration 0017 — Add per-asset partial index for the PM-due
-- mileage arm (closes data-architect Q1 BLOCKER on the PM-due
-- sweep PR for #74 PILOT-03).
--
-- Migration 0014 shipped `asset_maintenances_next_service_due_partial`
-- on `(tenantId, "nextServiceDate")` to cover the date arm of the
-- ADR-0016 §9 PM-due sweep. The mileage arm (`a."lastReadMileage"
-- + 500 >= am."nextServiceMileage"`) had no supporting partial,
-- which would force a heap scan of `asset_maintenances` filtered by
-- `tenantId/status/nextServiceMileage IS NOT NULL` per tenant per
-- day. At the design ceiling (1k tenants × 100k completed-historic
-- tickets), that was a multi-second daily cron per tenant.
--
-- Adding the symmetric partial means each arm of the rewritten
-- UNION query (see maintenance-sweep.service.ts) probes its own
-- partial index, with the join from `assets` driving via
-- `(tenantId, assetId)` so the `+ 500` shift is evaluated as a
-- per-row filter on a small candidate set rather than as an index
-- range scan.
--
-- Column tuple: `(tenantId, assetId, nextServiceMileage)` —
-- assetId before mileage so the planner can drive a nested-loop
-- join from `assets` (cheap, ~10k rows for a big tenant) into
-- the partial by assetId, then evaluate the mileage shift inline.

CREATE INDEX "asset_maintenances_next_service_mileage_due_partial"
    ON "asset_maintenances" ("tenantId", "assetId", "nextServiceMileage")
    WHERE status = 'COMPLETED' AND "nextServiceMileage" IS NOT NULL;

COMMENT ON INDEX "asset_maintenances_next_service_mileage_due_partial" IS
    'ADR-0016 §9 PM-due sweep — supports the mileage arm of the per-tenant '
    'UNION query in MaintenanceSweepService.runPmDueSweep. Symmetric to '
    'asset_maintenances_next_service_due_partial which covers the date arm.';
