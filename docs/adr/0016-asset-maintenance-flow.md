# ADR-0016: Asset maintenance flow (Snipe-IT-compatible)

- Status: Accepted (v2, 2026-04-19). Review log:
  - v1 (2026-04-19) → tech-lead REQUEST-CHANGES (3 blockers, 7
    concerns; counter-proposals for KeyShape registry,
    DomainEventBus, isStranded boolean), product-lead REVISE
    (3 P0 + 7 P1; Enterprise-placement of PM cron, stagger pilot,
    autoOpen=false), data-architect REQUEST-CHANGES (5 blockers,
    8 concerns; phantom Asset.lastReadMileage, per-table bypass
    policy missing, storage-key shape mismatch, missing partial
    indexes), security-reviewer REQUEST-CHANGES (4 blockers, 8
    concerns; PAT scope split, cross-tenant existence oracle via
    triggeringInspectionId, system-actor identity, autoOpen default
    surprise), persona-fleet-ops CHANGES-REQUESTED (1 blocker —
    auto-suggest also needed on check-in damageFlag = 70% of
    tickets — plus 7 ops concerns).
  - v2 (this doc) closes:
    - tech-lead B1 + data-architect B4 + security-reviewer C1 (photo
      key shape: `tenants/<uuid>/maintenance/<uuid>/<uuid>.<ext>`
      plural + regex+LIKE CHECK; KeyShape registry pattern in §6).
    - tech-lead B2 + security-reviewer C2 (subscriber as separate
      `DomainEventSubscriber` abstraction, runs under
      `runInTenant`, never `runAsSuperAdmin`).
    - tech-lead B3 + data-architect B2 (collapsed: `Reservation.isStranded BOOLEAN`
      replaces the STRANDED enum value — zero switch-site
      touchpoints, exclusion-constraint untouched, no migration
      split required).
    - data-architect B1 (`Asset.lastReadMileage Int?` shipped as
      part of migration 0014).
    - data-architect B3 (per-table privileged-bypass policy DDL
      spelled out in §1).
    - data-architect B5 + C2 (open-tickets-per-asset partial +
      next-service-due partial indexes added to §1).
    - persona-fleet-ops blocker (subscriber listens on BOTH
      `panorama.inspection.completed` AND a new
      `panorama.reservation.checked_in_with_damage` event — covers
      the 70% trigger path).
    - security-reviewer blocker #1 (Snipe-IT compat shim narrowed
      to **GET-only** for v1; existing `snipeit.compat.read` scope
      covers; POST/PATCH/DELETE deferred to 0.4 per product-lead's
      counter-proposal).
    - security-reviewer blocker #2 (BEFORE-INSERT trigger asserts
      `triggeringInspectionId.tenantId == maintenance.tenantId` AND
      `triggeringReservationId.tenantId == maintenance.tenantId`,
      SECURITY DEFINER — closes the existence-oracle).
    - security-reviewer blocker #3 (`Tenant.systemActorUserId UUID NOT NULL`
      seeded at tenant creation; auto-suggested tickets attribute
      to it, audit metadata carries `originalActorUserId`).
    - security-reviewer blocker #4 + product-lead P0#3 + persona
      concern #3 (default `autoOpenMaintenanceFromInspection=false`).
    - product-lead P0#1 (PM-due cron edition split: column + sweep
      + audit row in Community; email channel + polished UI in
      Enterprise — matches the inspection-retention-UI precedent
      already in feature-matrix.md).
    - product-lead P0#2 (pilot rollout staggered: FEATURE_INSPECTIONS
      canary green ≥7 d before FEATURE_MAINTENANCE flips).
- Date: 2026-04-19
- Deciders: Vitor Rodovalho
- Related: [ADR-0002 OSS/Community + Enterprise split](./0002-oss-commercial-split.md),
  [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md),
  [ADR-0009 Reservation domain](./0009-reservation-domain.md),
  [ADR-0010 Snipe-IT compat — auth](./0010-snipeit-compat-shim-auth.md),
  [ADR-0011 Notification event bus](./0011-notification-event-bus.md),
  [ADR-0012 Inspection + photo pipeline](./0012-inspection-photo-pipeline.md),
  [ADR-0015 BYPASSRLS removal](./0015-bypassrls-removal-refactor.md)

## Context

Roadmap 0.3 item 5 calls for "Asset maintenances, Snipe-IT-compatible
maintenance flow". This is the natural sequel to ADR-0012: today an
inspection that produces `FAIL` or `NEEDS_MAINTENANCE` fires an email
notification and… nothing else. There is nowhere in Panorama to track
the work that brings the asset back to `READY`. ADR-0012 deliberately
left this as a dead-end so the inspection ADR could ship in a single
release; this ADR fills the gap.

The user's production system today is **SnipeScheduler-FleetManager
v2.1** at Amtrak / FDT, which stitches a maintenance flow on top of a
Snipe-IT install via the `/api/v1/maintenances` endpoint. That stack is
the persona-fleet-ops grounding source. A pre-ADR scoping pass with
persona-fleet-ops surfaced concrete pain points the ADR must solve —
they are inlined below where they motivate a decision.

### Trigger paths (frequency-ranked, from persona-fleet-ops)

1. **Reservation check-in `damageFlag=true`** — by far the dominant
   path (≈70% of tickets). Driver toggles "needs maintenance" + free-
   text notes at return; today the asset flips to `MAINTENANCE` and
   ops staff must manually open a record from a separate screen
   (which they often forget — tickets get lost).
2. **Inspection FAIL / NEEDS_MAINTENANCE** — pre-trip at 5:30 AM the
   driver finds a problem before pulling out. Currently dead-end
   (per ADR-0012 §9).
3. **Scheduled mileage / time interval** (e.g. 7,500 mi or 180 d) —
   ≈15% of tickets. Hardcoded in FleetManager today; needs to be
   per-tenant configurable in Panorama.
4. **Vendor callback** ("Holman found a brake issue while doing the
   oil change") — back-channel, opened by ops after the fact.
5. **Walk-up to dispatch** — rare; contractor drivers without logins.

The v2 design auto-suggests draft tickets on paths 1 AND 2 (closing
the persona-fleet-ops blocker on path 1). Paths 3-5 stay manual.

### What today's tooling captures vs. theatre

Persona-fleet-ops baseline: of the ~12 fields in FleetManager's
`maintenance.php` form, only **asset, date opened, free-text notes,
opened-by** actually get filled in production. Cost is theatre
(belongs in accounting). Vendor defaults to a hardcoded "Holman
Service Station" string nobody fixes. The fields that are MISSING and
hurt every Tuesday morning:

- **Linkback to the reservation that flagged it** — today the
  maintenance page does not link back to the reservation, so when a
  ticket reads "rear bumper scuff" ops cannot find which trip caused
  it.
- **Linkback to the inspection that failed** (would close ADR-0012's
  dead-end).
- **Severity / restriction** — "vehicle is fine for a 20-min depot
  shuttle but not for a 4-hour summer run". Today the only state is
  fully-bookable or fully-blocked; ops works around with blackout
  slots that are invisible at booking time.
- **Assignee** distinct from opener — today two people work the same
  ticket or nobody does. There is no `maintenance_coordinator` role
  today; Panorama needs at minimum an assignee field.
- **Expected return-to-service date** — drives the alert dashboard.
- **Attached photos from the triggering inspection** — captured in
  0.3 #4 but they don't follow into the maintenance ticket.

### Killer scenario the ADR MUST handle

**Mid-shift breakdown by a contractor driver** (persona-fleet-ops
quote): a driver from the partner company calls dispatch at 11 AM, the
vehicle won't restart at a remote depot. The reservation is currently
`CHECKED_OUT`. Ops needs to:

1. Open a maintenance ticket against an asset that is **currently
   checked out** (not returned).
2. Keep the reservation in a defensible state — it's not "completed,"
   it's not "cancelled," the vehicle is **stranded**.
3. Dispatch a replacement vehicle to the same driver under the same
   trip.
4. Have the original reservation auto-link to the maintenance ticket
   so the vendor invoice can be traced back to the trip.

The v1 design modelled this with a new `STRANDED` enum value on
`ReservationStatus`. **v2 collapses to a boolean
`Reservation.isStranded` flag** — the lifecycle stays `CHECKED_OUT`
(operationally true: the keys are out, the asset is IN_USE), and
`isStranded = true` is the discriminator. This eliminates 18
switch-site touchpoints in `reservation.service.ts`, leaves migration
0010's exclusion-constraint predicate unchanged
(`lifecycleStatus IN ('BOOKED', 'CHECKED_OUT')` continues to block
re-booking the same window), and removes the `ALTER TYPE … ADD VALUE`
migration-split issue. See §4.

### Snipe-IT compat surface (v2: GET-only)

Snipe-IT exposes `GET/POST/PATCH/DELETE /api/v1/maintenances` with a
deliberately minimal object: `asset_id`, `supplier_id`,
`asset_maintenance_type` (enum: `Maintenance` / `Repair` / `PAT Test`
/ `Upgrade` / `Hardware Support` / `Software Support`), `title`,
`start_date`, `completion_date`, `cost`, `notes`, `is_warranty`,
`asset_maintenance_time` (server-computed days). Auth is per-user PAT
— shipped in ADR-0010 as a single `snipeit.compat.read` scope.

**v2 ships GET-only**: list + single-get under the existing
`snipeit.compat.read` scope. POST/PATCH/DELETE are **deferred to 0.4**
per product-lead's counter-proposal — the build cost of the write
shim (controller + field mapping + supplier-id reject path + DELETE
divergence doc) is non-trivial, the marginal value is one-off
data-import verification (which GET covers), and **no current
prospect has asked for write parity**. The split also makes
security-reviewer's PAT-scope blocker disappear (no new scopes
needed; existing `read` covers).

If a prospect surfaces in 0.4 with a real Snipe-IT-write dependency,
the write surface lands then with a proper scope split
(`snipeit.compat.maintenance.write` for POST/PATCH;
`snipeit.compat.maintenance.delete` for DELETE; reopen-via-PATCH
requires the `delete` scope OR session admin role).

## Decision

We ship a **first-class maintenance domain** with one primary entity
(`AssetMaintenance`), one supporting entity (`MaintenancePhoto`), one
auxiliary column on `Reservation` (`isStranded BOOLEAN`), one
auxiliary column on `Asset` (`lastReadMileage Int?`), and one
auxiliary column on `Tenant` (`systemActorUserId UUID NOT NULL`),
RLS-isolated per tenant, with a real status state-machine, first-
class FK-validated links to triggering reservations / inspections, an
assignee field, asset-status auto-flip on open / close, and a
notification subscriber that auto-suggests a maintenance ticket on
**both** inspection FAIL outcomes AND check-in damageFlag events.

**Critical design constraints embedded**:

- The state machine MUST permit opening a ticket against a
  `CHECKED_OUT` asset (the killer scenario). Asset-status flip is
  conditional, not unconditional; reservation stays CHECKED_OUT
  with `isStranded = true`.
- Cost / vendor / invoice are **out of scope for v1** (per persona-
  fleet-ops: nobody touches them, required fields will get garbage
  data). Captured as optional free-text only.
- Auto-rebook of bumped reservations is **out of scope** (per
  persona-fleet-ops: requester's plans have moved on by the time the
  vehicle is back; **notify, don't auto-book**).
- Partial states ("highway-only restriction") are out of scope for
  v1; existing blackout slot mechanism remains the workaround.
- Snipe-IT compat shim is **GET-only** in v1 (per the v2 review
  decision matrix). Write surface deferred to 0.4 if a real
  prospect asks.
- Photos hang off the existing `ObjectStorageModule` (ADR-0012 §3
  delivered) but reuse is via a new **`KeyShape` registry** + a
  `subjectKind: 'inspection' | 'maintenance'` discriminator —
  v1's "100% reuse" claim was materially false (per tech-lead B1).
- The `MaintenanceTicketSubscriber` is a new abstraction
  (`DomainEventSubscriber`) **distinct from** ADR-0011's
  `ChannelRegistry` — that registry is for write-side fan-out
  (event → email), not for cross-aggregate state mutation. The new
  abstraction runs the maintenance write inside the publishing
  service's own transaction via `recordWithin(tx, …)` semantics.
- `autoOpenMaintenanceFromInspection` defaults to `false` (security-
  reviewer blocker + product-lead P0 + persona concern converge);
  pilot tenants opt in after 30 d of stable inspection signal.
- PM-due cron (next-service-due) edition split per product-lead
  P0#1: data + sweep + audit row in **Community**, email-channel +
  polished alerts UI in **Enterprise**. Mirrors the
  `inspectionPhotoRetentionDays` precedent (column ships in
  Community, override UI is Enterprise-only).

## 1. Maintenance domain — schema (migration 0014)

### Tables

```prisma
model AssetMaintenance {
  id                       String                @id @default(uuid()) @db.Uuid
  tenantId                 String                @db.Uuid
  assetId                  String                @db.Uuid
  /// Snipe-IT-compat enum value. Strings (not native enum) so
  /// extension types ('Inspection', 'Tire', 'Calibration') do not
  /// require a migration. Daily audit query
  /// `panorama.maintenance.type_drift_detected` flags rows whose
  /// type is not in the controller's allow-list (per
  /// data-architect C6).
  maintenanceType          String                @db.VarChar(64)
  title                    String                @db.VarChar(200)
  status                   MaintenanceStatus     @default(OPEN)
  /// Free-text severity. Empty = unspecified. Restricted enum
  /// (LOW/MEDIUM/HIGH/CRITICAL) deferred to 0.4 — persona-fleet-
  /// ops validated free-text vs. enum: low-priority for v1.
  severity                 String?               @db.VarChar(40)
  /// Persona ask: link back to the reservation that flagged this.
  /// Nullable (scheduled / vendor-callback tickets have no
  /// triggering reservation). Cross-tenant FK protected by trigger
  /// `asset_maintenances_assert_triggers_same_tenant` (see below).
  triggeringReservationId  String?               @db.Uuid
  /// Persona ask: closes ADR-0012 dead-end. The notification
  /// subscriber populates this when auto-suggested from a FAIL.
  /// Same cross-tenant trigger applies.
  triggeringInspectionId   String?               @db.Uuid
  /// Persona ask: distinct from createdBy. Nullable until ops
  /// decides who owns this ticket.
  assigneeUserId           String?               @db.Uuid
  startedAt                DateTime              @default(now())
  /// Free-text supplier name. Snipe-IT has supplier_id FK; we
  /// keep that as a v0.4 follow-up (Supplier model not in scope
  /// today).
  supplierName             String?               @db.VarChar(200)
  mileageAtService         Int?
  /// Operator-set, drives the alerts dashboard. Distinct from
  /// completedAt — this is "when do we expect to close" while
  /// open.
  expectedReturnAt         DateTime?
  /// Operator-set, drives the next-service-due alert. Computed
  /// suggestion (UI hint only): `lastReadMileage +
  /// tenant.maintenanceMileageInterval`.
  nextServiceMileage       Int?
  nextServiceDate          DateTime?
  cost                     Decimal?              @db.Decimal(10, 2)
  isWarranty               Boolean               @default(false)
  /// PII-bearing free text. Service-layer write HTML-escapes
  /// before persist (security-reviewer blocker #3). Redacted
  /// from logs via PRISMA_REDACT_FIELDS extension.
  notes                    String?               @db.Text
  /// Set when status transitions to COMPLETED. Driven by
  /// service-layer setter (not a trigger) so completion audit
  /// row carries the right actor. Read-only after that.
  completedAt              DateTime?
  completedByUserId        String?               @db.Uuid
  completionNote           String?               @db.Text
  createdAt                DateTime              @default(now())
  /// For auto-suggested tickets, this is `tenant.systemActorUserId`
  /// (security-reviewer blocker #3). Audit metadata carries the
  /// original triggering actor under `originalActorUserId`.
  createdByUserId          String                @db.Uuid
  updatedAt                DateTime              @updatedAt

  tenant                   Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  asset                    Asset                 @relation(fields: [assetId], references: [id])
  triggeringReservation    Reservation?          @relation("MaintenanceTriggeringReservation", fields: [triggeringReservationId], references: [id], onDelete: SetNull)
  triggeringInspection     Inspection?           @relation("MaintenanceTriggeringInspection", fields: [triggeringInspectionId], references: [id], onDelete: SetNull)
  assignee                 User?                 @relation("MaintenanceAssignee", fields: [assigneeUserId], references: [id])
  createdBy                User                  @relation("MaintenanceCreatedBy", fields: [createdByUserId], references: [id])
  completedBy              User?                 @relation("MaintenanceCompletedBy", fields: [completedByUserId], references: [id])
  photos                   MaintenancePhoto[]

  @@index([tenantId, status, startedAt(sort: Desc)])
  @@index([tenantId, assetId, startedAt(sort: Desc)])
  @@index([tenantId, assigneeUserId])
  @@index([tenantId, triggeringInspectionId])
  @@index([tenantId, triggeringReservationId])
  @@map("asset_maintenances")
}

enum MaintenanceStatus {
  OPEN
  IN_PROGRESS
  COMPLETED
  CANCELLED

  @@map("maintenance_status")
}

model MaintenancePhoto {
  id                       String                @id @default(uuid()) @db.Uuid
  tenantId                 String                @db.Uuid
  maintenanceId            String                @db.Uuid
  /// KeyShape registry pattern (per tech-lead counter-proposal #1).
  /// Subject discriminator: 'maintenance'. Key shape:
  /// tenants/<tenantId>/maintenance/<maintenanceId>/<uuid>.<ext>
  /// matches ADR-0012 §3 plural-`tenants` convention. CHECK
  /// constraint enforces tenant + maintenance prefix via
  /// regex+LIKE (defence-in-depth; mirrors ADR-0012 §1 pattern).
  storageKey               String                @db.VarChar(512)
  contentType              String                @db.VarChar(80)
  bytes                    Int
  /// Mirror of ADR-0012 photo pipeline: clientUploadKey for
  /// idempotency, sha256 for dedupe, capturedAt from EXIF.
  clientUploadKey          String                @db.VarChar(80)
  sha256                   Bytes
  capturedAt               DateTime?
  createdAt                DateTime              @default(now())
  uploadedByUserId         String                @db.Uuid

  tenant                   Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  maintenance              AssetMaintenance      @relation(fields: [maintenanceId], references: [id], onDelete: Cascade)
  uploadedBy               User                  @relation("MaintenancePhotoUploader", fields: [uploadedByUserId], references: [id])

  @@unique([maintenanceId, clientUploadKey])
  @@index([tenantId, maintenanceId])
  @@map("maintenance_photos")
}
```

### Cross-cutting column additions (same migration 0014)

```prisma
// Added to existing Reservation model — replaces the v1
// proposal of a STRANDED enum value (per tech-lead counter-
// proposal #3 + data-architect blocker B2).
isStranded               Boolean               @default(false)

// Added to existing Asset model — closes data-architect blocker
// B1 (phantom column reference in v1 §9 query). Set by the
// reservation check-in flow (Reservation.mileageIn → Asset.lastReadMileage).
lastReadMileage          Int?

// Added to existing Tenant model — closes security-reviewer
// blocker #3 (auto-suggested tickets need a non-actor identity
// for createdByUserId). Seeded at tenant create as a deterministic
// system user (separate from owner/admin), with no AuthIdentity
// row so it can never log in. UUID stored to avoid a chicken-and-
// egg ordering during tenant bootstrap.
systemActorUserId        String                @db.Uuid

// Daily audit-only knob. Defaults to FALSE for v2 (per security-
// reviewer blocker #4 + product-lead P0#3 + persona concern #3
// convergence). Tenants opt in after pilot signal-to-noise is
// understood.
autoOpenMaintenanceFromInspection Boolean      @default(false)

// Per-tenant config — when true, maintenance.opened notifications
// fan out to the asset's last requester. Defaults FALSE
// (security-reviewer C5: info-disclosure to former renters).
notifyLastRequesterOnMaintenanceOpen Boolean  @default(false)

// Per-tenant defaults for the PM-due cron (Community ships
// the column + sweep; Enterprise ships the email channel).
maintenanceMileageInterval Int                @default(7500)
maintenanceDayInterval     Int                @default(180)
maintenanceStaleWarningDays Int               @default(60)
maintenanceReopenWindowDays Int               @default(14)
```

### Backfill (migration 0014)

- `Asset.lastReadMileage`:
  ```sql
  UPDATE assets a
     SET "lastReadMileage" = (
       SELECT MAX(r."mileageIn")
         FROM reservations r
        WHERE r."assetId" = a.id
          AND r."mileageIn" IS NOT NULL
     );
  ```
  Plus `CHECK ("lastReadMileage" IS NULL OR "lastReadMileage" >= 0)`.
- `Tenant.systemActorUserId`: per-tenant `INSERT INTO users (…)
  VALUES (…)` then `UPDATE tenants SET "systemActorUserId" = …`.
  The system user has `displayName = '<tenant.slug> System'`,
  `email = 'system+<tenant.id>@panorama.invalid'` (RFC-2606
  reserved domain — no real mailbox), `status = ACTIVE`, and NO
  `auth_identities` row (so `/login` can never authenticate as it).
  Membership row inserted with role = `system` (a new role added
  to the role enum or stored as a free-text role string — see
  next bullet).
- `Reservation.isStranded`: defaults to `false`; no backfill needed.
- `autoOpenMaintenanceFromInspection`, `notifyLastRequesterOnMaintenanceOpen`:
  defaults to `false`; no backfill needed.

### Role for system actor

The `system` role is added as a string value (no migration to the
`tenant_membership_role` enum; the existing column is already
free-text per the original ADR-0007 shape). Permission gates check
`role IN ('owner', 'fleet_admin')` for admin actions; `system` is
not in that set, so the system user's writes are NOT inherently
admin-privileged — the subscriber explicitly elevates only the
`runInTenant` scope (no role escalation; the maintenance write is
a SELECT-then-INSERT under the system user's tenant context, with
the controller bypass not used).

### CHECK constraints (migration 0014)

```sql
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

-- Photo storage-key strict shape (mirrors ADR-0012 §1 pattern;
-- closes tech-lead B1 + data-architect B4 + security C1)
ALTER TABLE "maintenance_photos"
  ADD CONSTRAINT "maintenance_photos_key_uuid_strict"
  CHECK (
    "storageKey" ~ '^tenants/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/maintenance/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|heic|heif)$'
    AND "storageKey" LIKE 'tenants/' || "tenantId"::text || '/maintenance/' || "maintenanceId"::text || '/%'
  );

-- Asset.lastReadMileage non-negative (in same migration)
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_last_read_mileage_nonneg"
  CHECK ("lastReadMileage" IS NULL OR "lastReadMileage" >= 0);
```

### Cross-tenant FK validation triggers (security-reviewer blocker #2)

```sql
-- Asserts triggeringInspectionId.tenantId == NEW.tenantId
-- AND triggeringReservationId.tenantId == NEW.tenantId.
-- SECURITY DEFINER so it bypasses RLS to read inspection/reservation
-- across tenants; explicitly fails closed if either FK target is
-- in a different tenant. Closes the existence-oracle attack
-- (tenant-A inserting a maintenance row referencing a tenant-B
-- inspection/reservation UUID).
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
```

### RLS policies (`rls.sql` step in migration 0014)

```sql
-- Tenant isolation on both tables
ALTER TABLE "asset_maintenances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_maintenances" FORCE ROW LEVEL SECURITY;

CREATE POLICY asset_maintenances_tenant_isolation ON "asset_maintenances"
  FOR ALL TO panorama_app
  USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);

ALTER TABLE "maintenance_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_photos" FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_photos_tenant_isolation ON "maintenance_photos"
  FOR ALL TO panorama_app
  USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);

-- Per-table privileged-bypass policies (closes data-architect
-- blocker B3 — migration 0013's DO-block sweep is one-shot; new
-- tables landing post-0013 must emit their own policy).
CREATE POLICY asset_maintenances_super_admin_bypass ON "asset_maintenances"
  FOR ALL TO panorama_super_admin
  USING (current_setting('panorama.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('panorama.bypass_rls', true) = 'on');

CREATE POLICY maintenance_photos_super_admin_bypass ON "maintenance_photos"
  FOR ALL TO panorama_super_admin
  USING (current_setting('panorama.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('panorama.bypass_rls', true) = 'on');
```

### Partial indexes (data-architect B5 + C2)

```sql
-- Hot path: "last open ticket on this asset?" query inside the
-- close-ticket tx (§3) AND the hourly stale sweep (§9). One
-- partial covers both at low storage cost.
CREATE INDEX "asset_maintenances_open_per_asset_partial"
  ON "asset_maintenances" ("tenantId", "assetId", "startedAt")
  WHERE status IN ('OPEN', 'IN_PROGRESS');

-- PM-due daily sweep (§9): WHERE status='COMPLETED' AND
-- nextServiceDate <= now() + 14d.
CREATE INDEX "asset_maintenances_next_service_due_partial"
  ON "asset_maintenances" ("tenantId", "nextServiceDate")
  WHERE status = 'COMPLETED' AND "nextServiceDate" IS NOT NULL;
```

### Migration 0014 single file (no enum-bump split needed)

Because v2 collapsed `STRANDED` to a boolean, **no `ALTER TYPE …
ADD VALUE`** is needed and migration 0014 lands as a single
transactional file. The v1 concern about Prisma's `BEGIN/COMMIT`
wrap conflicting with `ALTER TYPE` (data-architect B2) is moot.

## 2. State machine

```
       ┌──────► OPEN ──┐
       │           │
       │           ▼
   (create)   IN_PROGRESS
       │           │
       │           ▼
       │       COMPLETED ◄───────┐
       │           ▲             │
       │      (re-open guarded)  │
       │           │             │
       └──► CANCELLED ◄──────────┘
```

Allowed transitions (enforced in service layer, NOT in DB triggers):

| From         | To           | Who                  | Audit action                    |
|--------------|--------------|----------------------|---------------------------------|
| (new)        | OPEN         | owner / fleet_admin / requester* / system | `panorama.maintenance.opened`     |
| OPEN         | IN_PROGRESS  | assignee / admin     | `panorama.maintenance.work_started` |
| OPEN         | COMPLETED    | assignee / admin     | `panorama.maintenance.completed` |
| IN_PROGRESS  | COMPLETED    | assignee / admin     | `panorama.maintenance.completed` |
| OPEN         | CANCELLED    | admin                | `panorama.maintenance.cancelled` |
| IN_PROGRESS  | CANCELLED    | admin                | `panorama.maintenance.cancelled` |
| COMPLETED (within window) | OPEN | admin              | `panorama.maintenance.reopened` |
| COMPLETED (after window)  | (forbidden — must open new ticket) | — | — |

\*requester opens permitted ONLY when `triggeringReservationId IS NOT
NULL` and the requester owns that reservation. Service layer
enforces; controller re-checks. Per-tenant rate limit
(`maintenance.opens_per_requester_per_asset_per_day`, default 3)
prevents requester-account spam (persona concern #7).

\*system actor opens permitted via `MaintenanceTicketSubscriber`
only — the `createdByUserId` carries the system user's UUID and
audit metadata records the original triggering actor.

**Re-open window enforcement** lives in the service layer
(`MaintenanceService.reopen`) and reads
`tenant.maintenanceReopenWindowDays` (default 14). Outside the
window, the action is forbidden — the controller returns 422 with
"Open a new ticket linked to the same asset". Audit row reflects
the rejection.

**Service-layer state-machine vs. ADR-0012's BEFORE-UPDATE trigger
rationale**: ADR-0012 §2 used a trigger because
`inspection_snapshot_immutable` is a *physical-world* invariant
(the frozen artifact must not be silently rewritten). Maintenance
state is a *workflow* invariant where actor identity + reason +
audit attribution all matter — the trigger has no access to the
calling user, and the audit row must be emitted in the same tx as
the state change. Service-layer placement keeps actor + audit + state
co-located. The CHECK in §1
(`asset_maintenances_status_completed_consistent`) is the safety net
for buggy service paths; user-facing errors go through pre-validation
in the service.

**Last-open-ticket count race** (tech-lead concern #1): the close
flow runs inside `runTxWithRetry(SERIALIZABLE, …)` (the same wrapper
ADR-0009 §2 uses for reservation conflict detection). Two
concurrent admins closing two tickets on the same asset both
serialise; one retries with the other's update visible. The
asset-status flip count therefore sees the truth. Without
SERIALIZABLE this would race; the wrapper is non-optional and
called out in `MaintenanceService.complete()` head comment.

## 3. Asset state integration

Open + IN_PROGRESS maintenance flips the asset to `AssetStatus.MAINTENANCE`
UNLESS the asset is currently `IN_USE` (checked out). The killer
scenario:

- **Asset is READY / RESERVED**: opening a maintenance flips status
  to MAINTENANCE. Asset is hard-blocked from new reservations until
  status returns to READY (existing reservation behaviour from
  ADR-0009).
- **Asset is IN_USE (checked out)**: opening a maintenance does NOT
  flip status. The reservation remains CHECKED_OUT but
  `Reservation.isStranded` flips to `true`. A new audit event
  `panorama.maintenance.opened_on_checked_out` fires for visibility.
- **Closing a maintenance** (last open ticket on the asset transitions
  to COMPLETED or CANCELLED), inside SERIALIZABLE tx:
  - If asset is currently MAINTENANCE: flip to READY (only if no
    other open ticket on the asset — count-aware update under
    SERIALIZABLE).
  - If asset is currently IN_USE: no-op.
  - If asset is currently RETIRED: no-op (RETIRED is terminal;
    ADR-0009 §Asset states).

### Stranded asset returns days later (persona concern #2)

When a stranded asset gets towed back days after the maintenance
opened, it does NOT auto-flip via the normal check-in flow (the
reservation stays CHECKED_OUT with `isStranded = true`; check-in is
an action against the reservation, not against the asset alone).
v2 ships an explicit admin action **"Recover stranded asset"**
on the asset detail page that:

1. Confirms the asset is currently IN_USE AND has a CHECKED_OUT
   reservation with `isStranded = true`.
2. Flips the reservation to `RETURNED` (or `CANCELLED`, ops choice
   on the confirm screen) with `mileageIn = NULL` and a
   `cancelReason = "stranded - asset recovered"`.
3. Flips the asset to MAINTENANCE (the normal damage-on-checkin
   path) — the asset is back in the lot but presumably needs the
   work that the open ticket describes.
4. Audit: `panorama.asset.recovered_from_stranded` with
   `{maintenanceId, reservationId, action}` metadata.

This action is admin-only (`owner` / `fleet_admin`); the requester
can NOT recover (they don't have the keys). Web UI surfaces the
action when the conditions are met (§11).

### Archived assets (data-architect C5)

Service-layer assertion: `MaintenanceService.open()` rejects 422
with `"asset_archived"` when `asset.archivedAt IS NOT NULL`.
Existing open tickets on an asset are preserved on archive (no
cascade); admins close them on the asset's history page.

## 4. Reservation integration (the killer scenario)

For the mid-shift-breakdown case, the maintenance ticket is the
ANCHOR — the reservation is tagged `isStranded = true` while
remaining `CHECKED_OUT`. The transition:

- Trigger: opening a maintenance ticket via the dedicated **"Strand
  reservation"** action (separate from the generic "open ticket"
  button) when the source reservation is CHECKED_OUT.
- Effect: `Reservation.isStranded := true` and the maintenance
  ticket's `triggeringReservationId` is wired (FK trigger from §1
  asserts same-tenant). `mileageIn` / `checkedInAt` stay NULL —
  the asset is not back.
- Re-resolution: when the maintenance closes:
  - The stranded reservation does NOT auto-resolve.
  - `panorama.maintenance.completed` notification fires; the
    requester gets an email AND an in-app banner on the
    reservation detail page (persona concern #4): "Linked
    maintenance closed — please mark this reservation
    RETURNED or CANCELLED".
  - Ops resolves via the "Recover stranded asset" action (§3) or
    via a normal check-in if the driver brought it back.

**No auto-rebook.** Per persona-fleet-ops: requester's plans have
moved on by the time the vehicle is back. Notify, don't book. The
0.4 plugin can subscribe to `panorama.maintenance.completed` and
implement auto-rebook if a tenant requests it.

**Why isStranded boolean instead of new STRANDED enum value**:
- Zero switch-site touchpoints in `reservation.service.ts` (the
  v1 enum value would have touched 18 sites per tech-lead's audit).
- Migration 0010's exclusion-constraint predicate
  (`lifecycleStatus IN ('BOOKED', 'CHECKED_OUT')`) continues to
  block re-booking the same window — the asset is in the field, no
  one else can book it. Adding STRANDED would have required
  amending the predicate to include the new value, with a
  double-booking risk if missed.
- No `ALTER TYPE … ADD VALUE` migration-split needed (data-architect
  blocker B2 fully eliminated).
- The operational truth — "keys are out, asset is IN_USE" —
  matches `lifecycleStatus = CHECKED_OUT` semantically. The
  stranding is a *flag* on top of that truth, not a new state.

## 5. Notification subscriber — `MaintenanceTicketSubscriber`

### Abstraction: `DomainEventSubscriber` (new, distinct from `ChannelRegistry`)

`ChannelRegistry` (ADR-0011) is for **write-side fan-out**: an
event becomes an outbound side-effect (email, webhook). It is fire-
and-log; subscribers do not participate in the publishing tx. That
shape is wrong for cross-aggregate state mutation (creating a
maintenance row in response to an inspection completion):

- If the maintenance write throws SQLSTATE 40001 (serialisation
  conflict), the email channel pattern would silently drop the
  ticket creation while the audit + email proceed.
- Failure semantics ambiguous (does the inspection completion
  rollback if the ticket creation fails?).

v2 introduces `DomainEventSubscriber` as a separate primitive.
Subscribers are registered in `OnModuleInit`, run **inside the
publishing service's transaction** via `recordWithin(tx, …)`
semantics, and roll back together with the publisher on any error.
This is the same shape `audit.recordWithin(tx, …)` uses today.

The channel registry stays exclusively for outbound communication
(email, webhook, etc.). Intra-domain state mutation goes through
domain subscribers.

### Subscription scope (closes persona-fleet-ops blocker)

`MaintenanceTicketSubscriber` listens on **two** events:

1. `panorama.inspection.completed` — when `outcome IN ('FAIL',
   'NEEDS_MAINTENANCE')` AND `tenant.autoOpenMaintenanceFromInspection
   = true` (default `false` in v2). Covers persona-fleet-ops trigger
   path #2.
2. `panorama.reservation.checked_in_with_damage` — **NEW EVENT** the
   reservation check-in flow emits when `damageFlag = true`. AND
   `tenant.autoOpenMaintenanceFromInspection = true` (same flag —
   the name reads slightly off but the semantics are the same: auto-
   open from upstream signal). Covers the dominant 70% trigger path.

Both subscriptions create a **draft ticket** with:

- `status = OPEN`, `assigneeUserId = NULL`.
- `createdByUserId = tenant.systemActorUserId` (security-reviewer
  blocker #3).
- `triggeringInspectionId` and/or `triggeringReservationId` populated
  per source.
- `title` = `"Inspection follow-up: <asset.tag>"` for FAIL path,
  `"Damage flagged at check-in: <asset.tag>"` for damage path.
- `notes` = HTML-escape(`inspection.summaryNote ?? reservation.damageNote ?? ''`)
  — escape happens at write to neutralise XSS (security-reviewer
  blocker #3).
- `maintenanceType = 'Repair'` (safest default; admin can re-classify).

Inspection / reservation photos are NOT auto-copied (would double
storage); they're linked-by-reference at the photo browser
(see §6).

### Forbid-list invariant

The subscriber writes via `runInTenant(event.tenantId, …)` only.
`runAsSuperAdmin` is **forbidden** in `MaintenanceModule` (head-
comment + grep gate, mirroring ADR-0012's
`apps/core-api/src/modules/inspection/inspection.module.ts:25-31`
pattern). The `tenant.systemActorUserId` and the event's `tenantId`
provide enough identity to write within tenant scope; no privilege
escalation needed.

### Audit event metadata

`panorama.maintenance.opened` audit row, when emitted by the
subscriber, carries:

```json
{
  "source": "inspection_subscriber" | "checkin_subscriber",
  "triggeringInspectionId": "<uuid>" | null,
  "triggeringReservationId": "<uuid>" | null,
  "originalActorUserId": "<uuid>"
}
```

`originalActorUserId` is the `inspection.completedByUserId` or the
`reservation.checkedInByUserId`. Without this, the audit chain
would attribute every auto-suggested ticket to "system" with no path
back to who triggered it.

### Notification email

The existing ADR-0012 step 6 inspection-outcome email gets a new
line: "A draft maintenance ticket has been opened: /maintenance/<id>"
when the subscriber fired. No extra email; the existing recipients
learn about the ticket via the same notification.

For the damage-checkin path (no existing email subscriber today),
the existing reservation-event email stays unchanged — the new
draft ticket appears in the maintenance dashboard the next time
ops opens it. Adding a separate "ticket auto-opened from your check-
in" email is **deferred to 0.4** to avoid pager-fatigue on the
70% path.

## 6. Photos — KeyShape registry

### `KeyShape` registry pattern (closes tech-lead blocker B1)

The v1 claim "100% reuse of `assertKeyForTenant`" was materially
false: the existing
`apps/core-api/src/modules/object-storage/object-storage.keys.ts`
hardcodes a single regex matching only the inspection key shape.
v2 introduces a `KeyShape` registry:

```typescript
type SubjectKind = 'inspection' | 'maintenance';

interface KeyShape {
  subject: SubjectKind;
  // Matches: tenants/<uuid>/<subjectPath>/<uuid>/<uuid>.<ext>
  pattern: RegExp;
  // Used for cheap LIKE check + key generation:
  // 'tenants/{tenantId}/<subjectPath>/{subjectId}/'
  prefixOf: (tenantId: string, subjectId: string) => string;
}

const KEY_SHAPES: Record<SubjectKind, KeyShape> = {
  inspection: { … },
  maintenance: { … },
};

function assertKeyForTenant(
  key: string,
  tenantId: string,
  subjectKind?: SubjectKind,
): void {
  // If subjectKind omitted, infer from path prefix.
  // Always validate against the matching KeyShape.
}
```

DB CHECKs reference the same shape strings (literal regex per
table, since Postgres CHECK can't call a TS function). The
`maintenance_photos_key_uuid_strict` constraint above mirrors the
inspection one, plural `tenants` for consistency.

Photo cap: **100** per ticket (raised from v1's 50 per security-
reviewer concern #7 — the killer scenario plausibly accumulates
multiple vendor visits).

Retention: maintenance photos follow the SAME tenant retention
config as inspection photos (`tenant.inspectionPhotoRetentionDays`,
default 425 d, floor 30 d). One config knob, both subjects. A
separate `tenant.maintenancePhotoRetentionDays` is deferred to 0.4.

### Cross-link sidebar (closes security-reviewer blocker #2 chain)

When a maintenance ticket has `triggeringInspectionId`, the photo
browser renders the maintenance's own photos AND a read-only
sidebar listing the source inspection's photos with deep-links.

**Critical access path**: the sidebar reads inspection photos via:

```sql
SELECT * FROM inspection_photos
 WHERE "inspectionId" = $1
   AND "tenantId" = current_setting('panorama.current_tenant', true)::uuid
```

…under `runInTenant(maintenance.tenantId, …)` — never
`runAsSuperAdmin`. Because the FK trigger from §1 already guarantees
that `triggeringInspectionId.tenantId == maintenance.tenantId`, the
RLS-scoped read returns the inspection's photos when the link is
legitimate AND empty when the link was forged (which the FK trigger
prevents at write time, but defence-in-depth).

The cross-tenant existence-oracle attack (security-reviewer blocker
#2) is closed at the **write** boundary (FK trigger fails closed) AND
at the **read** boundary (RLS returns empty). Audit emits
`panorama.maintenance.cross_link_denied` if a read returns empty
when the FK target was supposedly populated — that signals either a
deleted inspection or a probing attack and should alert ops.

## 7. Notification events — Community / Enterprise split

### Audit events (always; both editions)

`panorama.maintenance.opened`, `.work_started`, `.completed`,
`.cancelled`, `.reopened`, `.assigned`, `.photo_uploaded`,
`.photo_viewed`, `.opened_on_checked_out`, `.notification_sent`,
`.notification_failed`, `.cross_link_denied`, `.feature_unlocked`,
`.snipeit_pat_read`, `.type_drift_detected`, `.updated`.

### Email channel — Community

These email events ship in Community because they support the
immediate ops loop (driver / dispatcher needs to know now):

- `panorama.maintenance.opened` — to assignee (when set on open)
  + to ticket creator. NOT to "asset's last requester" by default
  (`tenant.notifyLastRequesterOnMaintenanceOpen` per security-
  reviewer C5; default false).
- `panorama.maintenance.completed` — to ticket creator + to
  requester of the linked stranded reservation. Triggers the in-
  app banner on the reservation detail page (§11).
- `panorama.maintenance.assigned` — to the new assignee.
- `panorama.maintenance.updated` (debounced 5 min) — to the
  current assignee, when fields they care about change (severity,
  expectedReturnAt, supplierName). Persona concern #5: assignee
  doesn't know when others edit.

### Email channel — Enterprise (per product-lead P0#1, decision C)

These email events are **gated behind Enterprise edition** because
they constitute the "predictive alerts" line in the feature-matrix:

- `panorama.maintenance.next_service_due` — fan-out to fleet_admins
  when the daily PM-due cron fires. Self-hosters on Community
  still get the **audit row** + **dashboard query** but not the
  push email (matches the `inspectionPhotoRetentionDays` precedent:
  data ships in Community, override UI in Enterprise).

The Community-vs-Enterprise gate lives in `MaintenanceEmailChannel`:

```typescript
async dispatch(event: MaintenanceEvent): Promise<void> {
  if (event.type === 'next_service_due' && !this.edition.isEnterprise()) {
    // Community: audit-only, no email
    await this.audit.record('panorama.maintenance.community_silent', {
      eventType: event.type, tenantId: event.tenantId,
    });
    return;
  }
  // Otherwise, send the email
  await this.send(event);
}
```

`EditionService` is a new tiny service that reads
`PANORAMA_EDITION` env (default `community`); Enterprise builds set
it via the Cloud control plane or self-hoster's env.

### `notifyLastRequesterOnMaintenanceOpen` (security C5)

Default `false` — per security-reviewer C5, fanning maintenance
notifications to former renters leaks operational state. Tenants
opt in if they want it (some pilot customers will; persona's
contractor scenario explicitly wants this signal).

## 8. Snipe-IT compat shim — GET-only (v2 narrowed)

Adds **two** endpoints under the existing PAT-guarded
`/snipeit-compat/v1/` mount (ADR-0010), gated by the existing
`snipeit.compat.read` scope:

| Method | Path                      | Snipe-IT mirror              | Notes |
|--------|---------------------------|------------------------------|-------|
| GET    | `/maintenances`           | `/api/v1/maintenances`       | Pagination + `asset_id` filter. |
| GET    | `/maintenances/:id`       | `/api/v1/maintenances/:id`   | |

POST/PATCH/DELETE are **deferred to 0.4** if a real prospect
surfaces with a Snipe-IT-write dependency. Rationale (see review
decision matrix v2):

- The build cost of the write shim (controller + field mapping +
  supplier-id reject path + DELETE divergence doc) is non-trivial
  for a feature **no current prospect has asked for**.
- Security-reviewer's blocker #1 (PAT scope split into
  `read`/`write`/`delete`) disappears entirely — existing
  `snipeit.compat.read` PATs cover, no new scope-issuance UI
  needed.
- The marginal value of the write shim is one-off data-import
  verification, which GET covers (validate row counts, spot-check
  fields).

When write surface lands in 0.4 (if ever), it ships with:

- New scope `snipeit.compat.maintenance.write` for POST / PATCH.
- New scope `snipeit.compat.maintenance.delete` for DELETE
  (separate so a write-only PAT can't accidentally cancel).
- PATCH `completion_date = null` (re-open) requires the `delete`
  scope OR a session admin role assertion — re-opening a closed
  ticket is privilege-equivalent to deleting it from the audit
  perspective.
- DELETE returns Snipe-IT's actual envelope verbatim
  (`{status: "success", message: "Maintenance deleted"}`) but
  the row stays as CANCELLED (audit-floor invariant ADR-0010 §1).

### Field mapping (read-side)

| Snipe-IT field            | Panorama field                   | Notes |
|---------------------------|----------------------------------|-------|
| `asset_id`                | `assetId` (UUID)                 | UUID rendered as string; Snipe-IT clients that expect int IDs go through the existing `import_identity_map` reverse lookup (ADR-0010). |
| `supplier_id`             | (read-side: `null`)              | We don't have a Supplier model. Read returns `null`. |
| `asset_maintenance_type`  | `maintenanceType`                | Pass-through string. |
| `title`                   | `title`                          | |
| `start_date`              | `startedAt` (date portion only)  | |
| `completion_date`         | `completedAt` (date portion only) | `null` if not COMPLETED. |
| `cost`                    | `cost`                           | |
| `notes`                   | `notes`                          | Read returns the HTML-escaped value. |
| `is_warranty`             | `isWarranty`                     | |
| `asset_maintenance_time`  | (computed)                       | Server-computed: `completedAt - startedAt` in days, `null` when one is null. Read-only. |

Fields the shim does NOT expose: `status`, `assigneeUserId`,
`triggeringReservationId`, `triggeringInspectionId`, `severity`,
`mileageAtService`, `expectedReturnAt`, `nextServiceMileage`,
`nextServiceDate`, `completionNote`, `isStranded` (on the linked
reservation). These are visible only via Panorama's native
`/maintenance/*` API and web UI.

## 9. Maintenance sweeps

Reuses ADR-0012's `InspectionMaintenanceService` pattern (BullMQ
repeatable per ADR-0015 §4):

### Daily next-service-due sweep (Community: audit-only / Enterprise: email)

```sql
SELECT id, "assetId", "tenantId", "nextServiceDate", "nextServiceMileage"
  FROM asset_maintenances am
  JOIN assets a ON a.id = am."assetId" AND a."tenantId" = am."tenantId"
 WHERE am.status = 'COMPLETED'
   AND (
     (am."nextServiceDate" IS NOT NULL AND am."nextServiceDate" <= now() + interval '14 days')
     OR (am."nextServiceMileage" IS NOT NULL AND a."lastReadMileage" IS NOT NULL
         AND a."lastReadMileage" + 500 >= am."nextServiceMileage")
   );
```

The `Asset.lastReadMileage` reference is now real (column added in
migration 0014). Per-asset dedupe within 24 h via Redis SETNX
(same pattern as ADR-0012 §11 `photo.viewed` dedupe).

Audit row `panorama.maintenance.next_service_due` always fires;
email channel only fires under Enterprise edition (see §7).

### Hourly stale-OPEN sweep

```sql
SELECT id, "assetId", "tenantId", "startedAt"
  FROM asset_maintenances
 WHERE status IN ('OPEN', 'IN_PROGRESS')
   AND "startedAt" < now() - interval '1 day' * (
     SELECT "maintenanceStaleWarningDays" FROM tenants WHERE id = "tenantId"
   );
```

Emits `panorama.maintenance.stale_warning` audit row only (no
email). Ops dashboard pulls these.

### Daily type-drift audit (data-architect C6)

```sql
SELECT id, "tenantId", "maintenanceType", count(*)
  FROM asset_maintenances
 WHERE "maintenanceType" NOT IN (
   'Maintenance', 'Repair', 'PAT Test', 'Upgrade', 'Hardware Support',
   'Software Support', 'Inspection', 'Tire', 'Calibration'
 )
 GROUP BY id, "tenantId", "maintenanceType";
```

Emits `panorama.maintenance.type_drift_detected` for ops review.
Allow-list canonicalisation may follow in 0.4.

## 10. Roles + permissions

| Role            | Open  | Assign | Work (IN_PROGRESS) | Complete | Cancel | Re-open (within window) | Re-open (after window) | Strand reservation |
|-----------------|-------|--------|--------------------|----------|--------|-------------------------|------------------------|--------------------|
| owner           | ✓     | ✓      | ✓                  | ✓        | ✓      | ✓                       | ✗ (open new)           | ✓                  |
| fleet_admin     | ✓     | ✓      | ✓                  | ✓        | ✓      | ✓                       | ✗ (open new)           | ✓                  |
| requester       | ✓*    | ✗      | ✗                  | ✗        | ✗      | ✗                       | ✗                      | ✓*                 |
| system          | ✓**   | ✗      | ✗                  | ✗        | ✗      | ✗                       | ✗                      | ✗                  |
| (PAT, read-only)| ✗ (GET only — see §8) | ✗ | ✗            | ✗        | ✗      | ✗                       | ✗                      | ✗                  |

\*requester actions only on tickets where `triggeringReservationId`
points to a reservation they own AND under per-tenant rate limit
(default 3 opens per requester per asset per day; persona concern
#7). Service layer enforces; controller re-checks.

\*\*system actor opens via `MaintenanceTicketSubscriber` only — no
HTTP path. The `createdByUserId` carries the system user's UUID,
audit metadata records the `originalActorUserId`.

A dedicated `maintenance_coordinator` role is **deferred to 0.4 /
Enterprise**. Persona-fleet-ops surfaced this as a gap but agreed
the assignee field plus existing fleet_admin role covers the v1
ops workflow. Adding a fourth role pre-Enterprise crosses the
edition line (ADR-0002 §Role taxonomy stays minimal in Community).

## 11. Web UI

- `/maintenance` — list with filters (status, asset, assignee, "needs
  attention" = OPEN > 14 d).
- `/maintenance/new` — manual create (asset + type + title + notes;
  optional severity / mileage / supplier).
- `/maintenance/:id` — detail, status transitions, photo upload,
  inspection cross-link sidebar (§6), completion form.
- `/maintenance/:id/strand` — separate confirm screen for the
  strand-reservation flow (CHECKED_OUT → `isStranded = true`).
  Distinct from generic ticket open to prevent accidental misclicks
  (persona concern #6: "the friction is the feature").
- `/assets/:id` (existing page) gets a "Maintenance" tab listing
  open + recent completed tickets with quick-open button. When the
  asset is IN_USE AND linked to a CHECKED_OUT reservation with
  `isStranded = true`, the page surfaces the **"Recover stranded
  asset"** action (admin-only; §3).
- `/reservations/:id` (existing page) gets:
  - A side panel listing linked maintenance tickets.
  - When `isStranded = true` AND the ticket is CLOSED: **in-app
    banner** prompting "Linked maintenance closed — please mark
    this reservation RETURNED or CANCELLED" (persona concern #4).
- `/inspections/:id` (existing page) gets a "Linked maintenance"
  line when any maintenance row references this inspection.
- All maintenance state-mutation routes participate in the
  existing CSRF middleware (ADR-0007 §session-CSRF; security-
  reviewer concern #4).
- i18n bundles EN / PT-BR / ES (≈45 new keys; mirrors the
  inspection bundle pattern).

## 12. Feature flag + rollout

`FEATURE_MAINTENANCE` env flag, default `false`. Bootstrap-time
guard in `MaintenanceModule.onModuleInit` short-circuits the
controller registration when off (mirror of ADR-0012 §11 pattern).
The Snipe-IT compat shim's `/maintenances` endpoints return 404
when the flag is off (NOT 403 — Snipe-IT clients should see
"endpoint doesn't exist" not "forbidden", since the resource
genuinely isn't there).

### Staggered rollout (product-lead P0#2)

Pilot rollout sequence:

1. **FEATURE_INSPECTIONS** flips to `true` on Amtrak/FDT first
   (ADR-0012 step 13, already planned). Wait for ≥7 days of
   stable canary signal — no rollback, no major incidents.
2. **FEATURE_MAINTENANCE** flips to `true` on the same tenant
   only after the 7-day inspection canary closes clean. The
   features are functionally coupled (the auto-suggest subscriber
   needs inspections firing before maintenance has anything to
   subscribe to), and the cognitive load of two new flows on
   day 1 is real per persona-fleet-ops.
3. After ≥14 days of FEATURE_MAINTENANCE on Amtrak/FDT, evaluate
   for second pilot tenant. Community default flips only after
   ≥30 days across ≥2 tenants.

`tenant.autoOpenMaintenanceFromInspection` defaults to `false`
even after FEATURE_MAINTENANCE flips — pilot tenants opt in
explicitly after they've seen the FAIL/damage signal-to-noise
ratio with their checklist (persona / product-lead / security
convergent ask).

## Alternatives considered

### `STRANDED` enum value on ReservationStatus (v1 design)

Rejected in v2 per tech-lead counter-proposal #3 + data-architect
B2 + the ALTER-TYPE migration-split issue. The `isStranded BOOLEAN`
column gives the same operational semantics with zero switch-site
touchpoints + no enum migration cost + no risk of forgetting to
amend migration 0010's exclusion-constraint predicate.

### Snipe-IT POST/PATCH/DELETE in v1 (v1 design)

Rejected in v2 per the v2 review decision matrix (option B vs A).
Build cost is non-trivial, security-reviewer's PAT-scope blocker
disappears under the GET-only narrowing, and **no current
prospect has asked**. Write surface lands in 0.4 if a real
prospect surfaces.

### PM-due cron + email all in Community (v1 design)

Rejected in v2 per product-lead P0#1 + decision matrix option C.
Hybrid placement (data + sweep + audit Community; email + UI
Enterprise) preserves the matrix moat, mirrors the
`inspectionPhotoRetentionDays` precedent, and gives self-hosters
the signal without giving away the upsell.

### `autoOpenMaintenanceFromInspection` default true (v1 design)

Rejected in v2 per security-reviewer blocker #4 + product-lead
P0#3 + persona concern #3 (3-agent convergence). Default `false`
prevents flag-flip surprise for existing tenants and pilot pager-
fatigue while signal:noise calibrates.

### `MaintenanceTicketSubscriber` on `ChannelRegistry` (v1 design)

Rejected in v2 per tech-lead blocker B2. ChannelRegistry is for
write-side fan-out, not cross-aggregate state mutation. The new
`DomainEventSubscriber` abstraction runs subscribers inside the
publisher's tx (matching `audit.recordWithin(tx, …)` semantics),
preserving failure semantics.

### A separate Supplier model in v1

Rejected (carried over from v1). Persona-fleet-ops said cost/
vendor capture is theatre today; nobody fills it. Free-text
`supplierName` for v1; a real `Supplier` model lands in 0.4 if /
when an integration partner needs it.

### Hard delete on Snipe-IT-compat DELETE

Moot in v2 (no DELETE endpoint shipped). When the write surface
lands in 0.4, the divergence (soft-cancel vs. hard-delete) is
documented + clients see Snipe-IT's actual envelope on the
response per the security review.

### Auto-rebook stranded reservations

Rejected (carried over from v1). Per persona-fleet-ops's direct
testimony: the requester has moved on by the time the asset is
back. Notify-only is the v1 contract. 0.4 plugin can subscribe to
`panorama.maintenance.completed` and implement auto-rebook if a
tenant requests it.

### Severity as a real enum

Rejected for v1. Free-text severity for v1; structured restrictions
deferred to 0.4 (would need its own ADR — touches reservation
booking logic).

### Separate `maintenance_coordinator` role

Persona-fleet-ops asked for this. Rejected for Community v1 —
crosses the role-taxonomy line (ADR-0002 §Role floor). Assignee
field on the ticket gives the ops-grouping benefit without the
schema change.

### One table for both maintenance and inspection

Rejected (carried over from v1). Subclass into a single AssetCheck
hierarchy. The lifecycles diverge sharply (inspection = single short
event; maintenance = long-running ticket with assignee + status
machine).

## Consequences

### Positive

- Closes ADR-0012's notification dead-end. FAIL outcomes AND
  damage-checkin events both produce destinations.
- The killer scenario (mid-shift breakdown) is modelled end-to-end
  with `isStranded BOOLEAN` — zero switch-site cost, no
  exclusion-constraint risk, the operational truth ("keys are
  out") is preserved.
- Persona-fleet-ops concrete pain points (no reservation linkback,
  no assignee, no inspection cross-reference, 70% trigger path
  invisible) are resolved at the schema + subscriber level.
- One shared photo pipeline via the new `KeyShape` registry — the
  abstraction extends cleanly to future subjects (work orders,
  damage reports, etc.).
- Snipe-IT compat shim ships the read surface that supports
  migration verification, with the write surface deferrable to a
  real prospect signal.
- PM-due cron edition split preserves the Enterprise moat without
  starving Community of the signal.
- Cross-tenant existence-oracle attack closed at write boundary
  (FK trigger) AND read boundary (RLS).

### Negative

- Adds 2 tables, 1 enum, 4 columns on existing tables (Reservation,
  Asset, Tenant ×2 for system actor + autoOpen + the four
  maintenance-config defaults). Schema surface grows. Mitigated by
  reusing ADR-0012 patterns (RLS, photos, audit, notification) and
  by the v2 collapsing of STRANDED enum value to a boolean.
- Introduces `DomainEventSubscriber` as a new primitive parallel to
  `ChannelRegistry` — small abstraction surface to maintain. Pays
  for itself with the first cross-aggregate auto-suggest; second
  consumer (e.g. inspection auto-cancel on lost reservation) lands
  cheaper.
- The `KeyShape` registry adds one indirection to the photo
  pipeline call sites. Worth it: every future photo-bearing subject
  ships with one entry, not a whole new code path.
- No Supplier model = supplier name is free-text and dirty data
  will accumulate. Acceptable v1 tradeoff per persona ask.
- System-actor user per tenant + role string `system` adds a row
  to the tenant-create flow. Mitigated by being a single deterministic
  insert (no UI, no email, no AuthIdentity).
- Stranded asset recovery requires an admin click — not auto-resolved
  on check-in. Acceptable: the action is rare and the click guards
  against accidentally returning a still-broken vehicle.

### Neutral

- Maintenance tickets are NOT auto-deletable (CANCELLED is the
  terminal state; rows persist). GDPR hard-delete path is the same
  as ADR-0012's CLI-only super-admin break-glass.
- The `maintenance_coordinator` role question is officially
  deferred. If a pilot tenant pushes back, 0.4 lands the role.
- PM-due cron's Enterprise-vs-Community split is enforced via
  `EditionService` reading `PANORAMA_EDITION` env. Self-hosters
  who want the email channel can technically fork + flip — that's
  an accepted AGPL behaviour, not a bug.

## Rollback plan

- Migration 0014 is reversible: drop the two tables + the
  `MaintenanceStatus` enum + the four added columns
  (`Reservation.isStranded`, `Asset.lastReadMileage`,
  `Tenant.systemActorUserId`, `Tenant.autoOpenMaintenanceFromInspection`,
  `Tenant.notifyLastRequesterOnMaintenanceOpen`,
  `Tenant.maintenanceMileageInterval`,
  `Tenant.maintenanceDayInterval`,
  `Tenant.maintenanceStaleWarningDays`,
  `Tenant.maintenanceReopenWindowDays`).
- Drop the `system` role string from existing memberships
  (`UPDATE tenant_memberships SET role = 'requester' WHERE role
  = 'system'` — the system user becomes a regular requester; not
  loginable without an auth_identity row).
- Drop the `assert_maintenance_triggers_same_tenant` function +
  the trigger.
- `FEATURE_MAINTENANCE=false` makes the rollback safe at runtime —
  routes return 404, subscriber doesn't register, no sweeps fire.
  Photos in S3 follow the photo retention sweep; rollback does not
  delete S3 objects (audit-safe; manual cleanup if needed).
- `Asset.lastReadMileage` rebuilds losslessly from per-reservation
  `Reservation.mileageIn` if a re-introduction migration runs
  later (no data loss on drop).

## Execution order

1. **This ADR** — v3 → Accepted after surgical fixes close any v2
   remaining blockers (per ADR-0012 v3 cadence; v2 may not need a
   third formal review pass if v2 closes blockers cleanly).
2. **Migration 0014** — `asset_maintenances` + `maintenance_photos` +
   `maintenance_status` enum + new columns (`Reservation.isStranded`,
   `Asset.lastReadMileage`, `Tenant.systemActorUserId` + 4
   maintenance-config defaults + 2 autoOpen / notifyLastRequester
   flags) + 7 CHECK constraints + cross-tenant FK trigger + RLS
   (ENABLE + FORCE + per-table privileged-bypass policies) + 5
   indexes + 2 partial indexes. Backfill `Asset.lastReadMileage`
   from `Reservation.mileageIn`. Per-tenant system-user seed.
   `ROLLBACK.md` updated.
3. **`KeyShape` registry refactor** — extract subjects from
   hardcoded inspection regex into a registry. Inspection module's
   call sites updated to pass `subjectKind: 'inspection'` (or rely
   on prefix inference for back-compat). Existing tests must stay
   green.
4. **`DomainEventSubscriber` abstraction** — new primitive in
   `apps/core-api/src/modules/event-bus/` (or extend the existing
   notification module). Sample test demonstrates `recordWithin(tx,
   …)` rollback semantics.
5. **MaintenanceService** — CRUD + state-machine + asset-status
   integration + reservation-strand action + recover-stranded
   action + re-open window enforcement + per-requester rate limit.
   Audit hooks everywhere. Mandatory `runInTenant` lint comment +
   `runAsSuperAdmin` forbid-list head comment.
6. **MaintenanceController** — REST surface (`/maintenance/*`) +
   admin / requester role enforcement + photo upload (reuses
   PhotoPipeline + ObjectStorage modules unchanged via §3 KeyShape
   registry).
7. **MaintenanceTicketSubscriber** — registers on
   `panorama.inspection.completed` AND new
   `panorama.reservation.checked_in_with_damage` (which the
   reservation check-in flow now emits). Auto-suggests draft
   tickets via the system actor. Tenant flag
   `autoOpenMaintenanceFromInspection` defaulted **false**.
8. **Notification schema + channels** — register five event types
   (`opened`, `completed`, `assigned`, `updated`, `next_service_due`).
   `MaintenanceEmailChannel` ships in Community for the first four;
   gates `next_service_due` behind Enterprise via `EditionService`.
   Trilingual templates EN / PT-BR / ES.
9. **Snipe-IT compat extension** — TWO endpoints
   (`GET /snipeit-compat/v1/maintenances` + `GET /snipeit-compat/v1/maintenances/:id`),
   PAT-scoped via existing `snipeit.compat.read`. Field mapping
   helper. No POST/PATCH/DELETE in v1.
10. **Maintenance sweeps** — daily next-service-due cron + hourly
    stale-OPEN sweep + daily type-drift audit, all BullMQ
    repeatable per ADR-0015 §4.
11. **Cross-cutting integration tests** — RLS cross-tenant blocked,
    cross-tenant FK trigger blocks the existence-oracle attack,
    killer-scenario end-to-end (open on CHECKED_OUT → reservation
    isStranded → close → notify → recover), inspection FAIL →
    auto-suggest (default-off path) → opt-in → accept, check-in
    damageFlag → auto-suggest, Snipe-IT compat read round-trip,
    asset status flip on open / close (with multi-ticket case),
    re-open within window vs. outside, photo upload + cross-link
    to inspection photos under `runInTenant` only,
    DomainEventSubscriber rollback semantics.
12. **Web UI** — list, detail, strand confirm, asset-tab + recover
    action, reservation side panel + in-app banner on close,
    inspection cross-link line. i18n bundles.
13. **Docs** — `docs/en/maintenance.md` ops doc (covers killer
    scenario + Snipe-IT GET-only contract + isStranded semantics
    + inspection auto-suggest opt-in path + edition split for the
    PM-due cron); roadmap.md 0.3 #5 → `[~]` then `[x]` after step
    14; feature-matrix.md row updated to reflect the
    Community-vs-Enterprise split for the email channel.
14. **Canary rollout** — `FEATURE_INSPECTIONS=true` canary closes
    clean for ≥7 days → THEN `FEATURE_MAINTENANCE=true` on
    Amtrak/FDT pilot. After ≥14 days, evaluate for second pilot
    tenant. After ≥30 days across ≥2 tenants, Community default
    flips. `autoOpenMaintenanceFromInspection` opt-in per pilot
    tenant after their own signal:noise calibration.

**Future-facing commitments** (recorded so 0.4+ contributors don't
re-open this ADR):

- **`maintenance_coordinator` role** — 0.4 if pilot pushes back
  on assignee-only being insufficient.
- **Supplier model + cost rollups** — 0.4 / Enterprise. Tied to
  the Fleetio Connect plugin work in ADR-0006 §Plugin SDK
  enterprise integrations.
- **Snipe-IT POST / PATCH / DELETE** — 0.4 if a real Snipe-IT-
  write prospect surfaces. Scope split into `read` / `write` /
  `delete`; PATCH-reopen requires `delete` scope.
- **Restriction-state on assets** ("highway-only", "depot-only") —
  0.4. Needs its own ADR — touches reservation booking eligibility.
- **Auto-rebook stranded reservations** — 0.4 if requested. v1 is
  notify-only.
- **Per-asset PM schedule** (mileage / time interval per asset
  class) — 0.4. Today the daily sweep uses per-ticket
  `nextServiceMileage` / `nextServiceDate`; a real PM scheduler
  needs a separate `MaintenancePlan` entity.
- **`maintenance.completed` plugin hook** — 0.4. Mirror of
  ADR-0012's `onInspectionCompleted` plugin commitment.
- **Separate `maintenancePhotoRetentionDays`** — 0.4 if a tenant
  pushes back on unified retention.
- **`type_drift_detected` allow-list canonicalisation** — 0.4.
  Today's daily audit row flags drift; a future job could
  canonicalise non-canonical types into the closest match.

Each step lands as its own commit, gated by the agent review team.
Step 1 → step 2 is the next commit; subsequent steps gated by
post-commit reviews where relevant.
