-- Migration 0014 — Asset maintenance flow (ADR-0016 v2 Accepted).
--
-- Two new tables (`asset_maintenances`, `maintenance_photos`),
-- one new enum (`maintenance_status`), four new columns on
-- existing tables (Reservation.isStranded, Asset.lastReadMileage,
-- Tenant.systemActorUserId + 6 maintenance-config defaults), 8
-- CHECK constraints, 1 cross-tenant FK trigger function +
-- trigger, 5 main indexes + 2 partial indexes. RLS policies live
-- in the companion `rls.sql` run after this. Rollback is in
-- ROLLBACK.md.
--
-- v2 collapsed the v1 `STRANDED` enum value to a boolean column
-- (`Reservation.isStranded`) — zero switch-site touchpoints, no
-- enum-bump migration split, the migration-0010 exclusion-
-- constraint predicate continues to block re-booking. See
-- ADR-0016 §4.

-- ---------------------------------------------------------------
-- 1. New enum
-- ---------------------------------------------------------------
CREATE TYPE "maintenance_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- ---------------------------------------------------------------
-- 2. New columns on existing tables (additive; no data loss)
-- ---------------------------------------------------------------

-- Asset.lastReadMileage — drives PM-due cron distance predicate.
-- Backfilled below from MAX(reservations.mileageIn).
ALTER TABLE "assets" ADD COLUMN "lastReadMileage" INTEGER;

ALTER TABLE "assets"
    ADD CONSTRAINT "assets_last_read_mileage_nonneg"
    CHECK ("lastReadMileage" IS NULL OR "lastReadMileage" >= 0);

-- Reservation.isStranded — killer-scenario discriminator
-- (mid-shift breakdown). LifecycleStatus stays CHECKED_OUT;
-- isStranded=true is the flag. Defaults false; no backfill
-- needed.
ALTER TABLE "reservations" ADD COLUMN "isStranded" BOOLEAN NOT NULL DEFAULT false;

-- Tenant — ADR-0016 columns. systemActorUserId is added NULLable
-- here, backfilled below, then SET NOT NULL.
ALTER TABLE "tenants"
    ADD COLUMN "systemActorUserId" UUID,
    ADD COLUMN "autoOpenMaintenanceFromInspection" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "notifyLastRequesterOnMaintenanceOpen" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "maintenanceMileageInterval" INTEGER NOT NULL DEFAULT 7500,
    ADD COLUMN "maintenanceDayInterval" INTEGER NOT NULL DEFAULT 180,
    ADD COLUMN "maintenanceStaleWarningDays" INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN "maintenanceReopenWindowDays" INTEGER NOT NULL DEFAULT 14;

-- ---------------------------------------------------------------
-- 3. Backfills
-- ---------------------------------------------------------------

-- Asset.lastReadMileage from per-reservation check-in mileage.
UPDATE "assets" a
   SET "lastReadMileage" = sub."maxMileage"
  FROM (
    SELECT "assetId", MAX("mileageIn") AS "maxMileage"
      FROM "reservations"
     WHERE "mileageIn" IS NOT NULL AND "assetId" IS NOT NULL
     GROUP BY "assetId"
  ) sub
 WHERE a.id = sub."assetId";

-- Per-tenant system user seed.
-- Each tenant gets ONE system user (no AuthIdentity, never logs
-- in). Email uses RFC-2606 reserved `.invalid` TLD so no real
-- mailbox exists. Membership row uses role='system' (free-text
-- column; ADR-0016 §1 confirms this is the right encoding).
DO $$
DECLARE
  t RECORD;
  new_user_id UUID;
BEGIN
  FOR t IN SELECT id, slug FROM "tenants" WHERE "systemActorUserId" IS NULL
  LOOP
    new_user_id := gen_random_uuid();
    INSERT INTO "users" (id, email, "displayName", status, "createdAt", "updatedAt")
    VALUES (
      new_user_id,
      'system+' || t.id::text || '@panorama.invalid',
      COALESCE(t.slug, 'tenant') || ' System',
      'ACTIVE',
      NOW(),
      NOW()
    );
    INSERT INTO "tenant_memberships" (id, "tenantId", "userId", role, status, "createdAt", "updatedAt")
    VALUES (
      gen_random_uuid(),
      t.id,
      new_user_id,
      'system',
      'active',
      NOW(),
      NOW()
    );
    UPDATE "tenants" SET "systemActorUserId" = new_user_id WHERE id = t.id;
  END LOOP;
END
$$;

-- After backfill, enforce NOT NULL.
ALTER TABLE "tenants" ALTER COLUMN "systemActorUserId" SET NOT NULL;

-- ---------------------------------------------------------------
-- 4. New tables
-- ---------------------------------------------------------------

CREATE TABLE "asset_maintenances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "maintenanceType" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" "maintenance_status" NOT NULL DEFAULT 'OPEN',
    "severity" VARCHAR(40),
    "triggeringReservationId" UUID,
    "triggeringInspectionId" UUID,
    "assigneeUserId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierName" VARCHAR(200),
    "mileageAtService" INTEGER,
    "expectedReturnAt" TIMESTAMP(3),
    "nextServiceMileage" INTEGER,
    "nextServiceDate" TIMESTAMP(3),
    "cost" DECIMAL(10,2),
    "isWarranty" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "completionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_maintenances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_photos" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "maintenanceId" UUID NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(80) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "clientUploadKey" VARCHAR(80) NOT NULL,
    "sha256" BYTEA NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" UUID NOT NULL,

    CONSTRAINT "maintenance_photos_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------
-- 5. Indexes (5 main + 2 partial — partials ADR-0016 §1
--    data-architect B5/C2)
-- ---------------------------------------------------------------

CREATE INDEX "asset_maintenances_tenantId_status_startedAt_idx"
    ON "asset_maintenances" ("tenantId", "status", "startedAt" DESC);

CREATE INDEX "asset_maintenances_tenantId_assetId_startedAt_idx"
    ON "asset_maintenances" ("tenantId", "assetId", "startedAt" DESC);

CREATE INDEX "asset_maintenances_tenantId_assigneeUserId_idx"
    ON "asset_maintenances" ("tenantId", "assigneeUserId");

CREATE INDEX "asset_maintenances_tenantId_triggeringInspectionId_idx"
    ON "asset_maintenances" ("tenantId", "triggeringInspectionId");

CREATE INDEX "asset_maintenances_tenantId_triggeringReservationId_idx"
    ON "asset_maintenances" ("tenantId", "triggeringReservationId");

CREATE INDEX "maintenance_photos_tenantId_maintenanceId_idx"
    ON "maintenance_photos" ("tenantId", "maintenanceId");

CREATE UNIQUE INDEX "maintenance_photos_maintenanceId_clientUploadKey_key"
    ON "maintenance_photos" ("maintenanceId", "clientUploadKey");

-- Hot path: "last open ticket on this asset?" inside the close-
-- ticket SERIALIZABLE tx (§3) AND the hourly stale sweep (§9).
-- One partial covers both at minimal storage cost.
CREATE INDEX "asset_maintenances_open_per_asset_partial"
    ON "asset_maintenances" ("tenantId", "assetId", "startedAt")
    WHERE status IN ('OPEN', 'IN_PROGRESS');

-- PM-due daily sweep: WHERE status='COMPLETED' AND
-- nextServiceDate <= now() + 14d. Partial scoped to completed
-- rows with a non-null due date.
CREATE INDEX "asset_maintenances_next_service_due_partial"
    ON "asset_maintenances" ("tenantId", "nextServiceDate")
    WHERE status = 'COMPLETED' AND "nextServiceDate" IS NOT NULL;

-- ---------------------------------------------------------------
-- 6. Foreign keys
-- ---------------------------------------------------------------

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_triggeringReservationId_fkey"
    FOREIGN KEY ("triggeringReservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_triggeringInspectionId_fkey"
    FOREIGN KEY ("triggeringInspectionId") REFERENCES "inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_assigneeUserId_fkey"
    FOREIGN KEY ("assigneeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_maintenances" ADD CONSTRAINT "asset_maintenances_completedByUserId_fkey"
    FOREIGN KEY ("completedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_maintenanceId_fkey"
    FOREIGN KEY ("maintenanceId") REFERENCES "asset_maintenances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "maintenance_photos" ADD CONSTRAINT "maintenance_photos_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------
-- 7. CHECK constraints (ADR-0016 §1)
-- ---------------------------------------------------------------

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_status_completed_consistent"
    CHECK (
        (status = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedByUserId" IS NOT NULL)
        OR (status <> 'COMPLETED' AND "completedAt" IS NULL AND "completedByUserId" IS NULL)
    );

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_type_nonempty"
    CHECK (length("maintenanceType") >= 3);

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_title_nonempty"
    CHECK (length(title) >= 3);

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_cost_nonneg"
    CHECK (cost IS NULL OR cost >= 0);

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_mileage_nonneg"
    CHECK ("mileageAtService" IS NULL OR "mileageAtService" >= 0);

ALTER TABLE "asset_maintenances"
    ADD CONSTRAINT "asset_maintenances_next_mileage_after"
    CHECK ("nextServiceMileage" IS NULL OR "mileageAtService" IS NULL OR "nextServiceMileage" > "mileageAtService");

-- Photo storage-key strict shape — mirrors ADR-0012 §1 pattern
-- (closes tech-lead B1 + data-architect B4 + security C1).
-- Plural `tenants/` matches ADR-0012 §3 convention.
ALTER TABLE "maintenance_photos"
    ADD CONSTRAINT "maintenance_photos_key_uuid_strict"
    CHECK (
        "storageKey" ~ '^tenants/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/maintenance/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|heic|heif)$'
        AND "storageKey" LIKE 'tenants/' || "tenantId"::text || '/maintenance/' || "maintenanceId"::text || '/%'
    );

-- ---------------------------------------------------------------
-- 8. Cross-tenant FK validation trigger (security-reviewer
--    blocker #2). SECURITY DEFINER bypasses RLS to read the
--    inspection/reservation tenantId for the assertion; fails
--    closed if the FK target is in another tenant.
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_maintenance_triggers_same_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    insp_tenant UUID;
    resv_tenant UUID;
BEGIN
    IF NEW."triggeringInspectionId" IS NOT NULL THEN
        SELECT "tenantId" INTO insp_tenant FROM "inspections" WHERE id = NEW."triggeringInspectionId";
        IF insp_tenant IS NULL THEN
            RAISE EXCEPTION 'maintenance_trigger_inspection_not_found' USING ERRCODE = '23503';
        END IF;
        IF insp_tenant <> NEW."tenantId" THEN
            RAISE EXCEPTION 'maintenance_trigger_inspection_cross_tenant' USING ERRCODE = '23503';
        END IF;
    END IF;
    IF NEW."triggeringReservationId" IS NOT NULL THEN
        SELECT "tenantId" INTO resv_tenant FROM "reservations" WHERE id = NEW."triggeringReservationId";
        IF resv_tenant IS NULL THEN
            RAISE EXCEPTION 'maintenance_trigger_reservation_not_found' USING ERRCODE = '23503';
        END IF;
        IF resv_tenant <> NEW."tenantId" THEN
            RAISE EXCEPTION 'maintenance_trigger_reservation_cross_tenant' USING ERRCODE = '23503';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER asset_maintenances_assert_triggers_same_tenant
    BEFORE INSERT OR UPDATE OF "triggeringInspectionId", "triggeringReservationId"
    ON "asset_maintenances"
    FOR EACH ROW
    EXECUTE FUNCTION assert_maintenance_triggers_same_tenant();
