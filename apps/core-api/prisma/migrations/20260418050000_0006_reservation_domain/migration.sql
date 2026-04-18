-- Migration 0006 — Reservation domain (ADR-0009).
--
-- Adds:
--   * Approval + cancel trail columns on `reservations`.
--   * Two extra indexes on `reservations` for the common admin list
--     queries (by requester, by lifecycle status).
--   * `blackout_slots` table with optional per-asset scope.
--   * `tenants.reservationRules` JSON column for per-tenant policy.
--
-- Conflict detection stays at service level for 0.2; if we see real
-- contention the follow-up is an exclusion constraint on a generated
-- tstzrange column (see ADR-0009 §Alternatives considered).

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approverUserId" UUID,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledByUserId" UUID;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "reservationRules" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "blackout_slots" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID,
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blackout_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blackout_slots_tenantId_startAt_idx" ON "blackout_slots"("tenantId", "startAt");

-- CreateIndex
CREATE INDEX "blackout_slots_tenantId_assetId_idx" ON "blackout_slots"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "reservations_tenantId_requesterUserId_idx" ON "reservations"("tenantId", "requesterUserId");

-- CreateIndex
CREATE INDEX "reservations_tenantId_lifecycleStatus_idx" ON "reservations"("tenantId", "lifecycleStatus");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_onBehalfUserId_fkey" FOREIGN KEY ("onBehalfUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blackout_slots" ADD CONSTRAINT "blackout_slots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blackout_slots" ADD CONSTRAINT "blackout_slots_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
