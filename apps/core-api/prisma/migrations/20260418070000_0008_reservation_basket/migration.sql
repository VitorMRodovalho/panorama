-- Migration 0008 — Reservation basket (ADR-0009 update: option B).
--
-- `basketId` is a nullable UUID that groups reservations created
-- together (e.g. "3 trucks for this site visit" → one API call, 3
-- reservations, same basketId). The ADR went with option B (shared
-- basketId on Reservation) over option A (reservation_items line-
-- item table) because:
--   1. Schema stays thin — one nullable column.
--   2. Each row keeps its own lifecycle (approve, check-out, cancel)
--      independently; basket is purely a creation-time + UX grouping.
--   3. Fleet-asset use cases typically want a specific vehicle, not a
--      model-pool allocation, so FleetManager's `reservation_items`
--      (optimised for "2 cameras of model X") buys complexity we
--      don't need yet.
--
-- No RLS change — the existing `reservations_tenant_isolation` policy
-- FOR ALL predicate already filters every column in the table.

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "basketId" UUID;

-- CreateIndex
CREATE INDEX "reservations_tenantId_basketId_idx" ON "reservations"("tenantId", "basketId");
