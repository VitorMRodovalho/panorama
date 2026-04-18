# ADR-0012: Inspection checklists + photo evidence pipeline

- Status: Accepted (v3, 2026-04-18). Review log:
  - v1 → tech-lead REQUEST-CHANGES (2 blockers), data-architect
    REQUEST-CHANGES (8 index/trigger concerns), security-reviewer
    BLOCK (7 blockers), product-lead REVISE (3 P0 + 4 P1),
    persona-fleet-ops CHANGES-REQUESTED (10 ops-blocking).
  - v2 → tech-lead REQUEST-CHANGES (1 cross-module coupling
    blocker + 6 concerns), security-reviewer REQUEST-CHANGES (2
    new blockers: FORCE-RLS + photoId existence oracle),
    persona-fleet-ops APPROVE architecture-level.
  - v3 (this doc) → closes tech-lead's cross-module blocker by
    dropping the `InspectionService.latestPassForCheckout`
    pattern; `ReservationService.checkOut` reads `inspections`
    directly via its existing Prisma client (same as it reads
    `tenant`, `asset`, `reservation`). Closes security-reviewer's
    FORCE-RLS blocker (rls.sql sketch pairs ENABLE+FORCE on every
    table) + photoId existence oracle (server mints PK; client
    supplies `clientUploadKey` with UNIQUE(inspectionId,
    clientUploadKey); ownership re-check on 23505). Plus: GUC
    namespace `panorama.*` consistency, retention default 425 d
    (DOT §396.3 14-mo floor + 2-mo buffer), DNS-resolve SSRF
    guard, sharp exact-pin, auto_cancelled audit row, trigger
    SECURITY DEFINER, dedup key with viewKind, authorization
    added to redactor, `assertKeyForTenant` regex-match not
    prefix-match, maxPhotosPerInspection ceiling raised to 100,
    0.4 tenant-admin self-serve hard-delete commitment.
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md),
  [ADR-0009 Reservation domain](./0009-reservation-domain.md),
  [ADR-0011 Notification event bus](./0011-notification-event-bus.md),
  [ADR-0010 Snipe-IT compat — auth](./0010-snipeit-compat-shim-auth.md)
  (env-var conventions + redactor pattern)

## Context

Roadmap 0.3 item 4 calls for "configurable checklists (per asset type),
photo evidence, EXIF strip". Ops uses pre-trip / post-trip inspections
to prove condition-at-handoff (insurance + liability) and to catch
damage before a vehicle goes back into the pool. Inspections at
SnipeScheduler-FleetManager v2.1 today are free-text notes in the
reservation `condition_in` / `condition_out` columns; a bolt-on
`inspection_checklist.php` / `inspection_photos.php` module that
Amtrak / FDT wired in locally gives them structured forms +
photo attachments, but no audit trail beyond the reservation row and
no tenant isolation. Panorama 0.3 must match or beat that.

The Amtrak / FDT ops teams (see
[`agents/persona-fleet-ops.md`](../../.claude/agents/persona-fleet-ops.md))
have asked for:

- **Checklists that ops can edit** — not a hard-coded list of
  "tire pressure / fluids / lights". Ops edits the template, drivers
  follow it.
- **Photo evidence** — pre-trip photos of all four sides + damage
  shots at return. Body-shop downstream needs the photo paired with
  the claim.
- **EXIF strip with shutter-time preservation** — phones embed GPS +
  owner info; strip aggressively to avoid a privacy footgun, but
  preserve `DateTimeOriginal` (shutter time) because an insurance
  hearing will ask "when was this taken" and `uploadedAt` isn't
  credible after a connectivity retry.
- **Reservation tether** — DOT 49 CFR §396.11 requires a pre-trip
  inspection report on every CMV operation. A commercial-fleet pilot
  cannot check out a vehicle without a completed pre-trip. This is
  the compliance-blocking scenario ops-persona flagged and it moves
  required-before-checkout INTO 0.3 (see §8).
- **FAIL-outcome visibility** — a failed pre-trip must reach ops
  without ops having to refresh a dashboard. 0.3 ships an email
  subscriber; ops-dashboard red banner + review-queue land with
  the web UI.
- **Audit trail** — "the pre-trip inspection said the tyre was fine,
  who clicked the checkbox, when, from where". Answerable from one
  query over `audit_events`.
- **Upload reliability on spotty connectivity** — ops on a tablet at
  5:30 AM in the depot. 0.3 is web-only; the client-side upload
  contract is "synchronous, one photo = one request, retry with the
  same client-generated photoId for idempotency". Mobile offline-
  first queue is 1.1+. This ADR commits to the exact retry contract
  so a contributor doesn't have to guess.

### Failure modes we're defending against

- **Leaked driver location** — GPS EXIF on an uploaded photo exposes
  the driver's home address precision. Privacy + liability issue.
- **Shutter-time lost to connectivity retry** — driver takes photo at
  07:15, loses connectivity, reconnects at 08:45, photo uploads;
  server `uploadedAt` says 08:45, insurance challenges the claim.
- **Template edit corrupts history** — ops edits "Check tire pressure"
  to "Check tire pressure and wear" AFTER 500 inspections ran with
  the old wording. The audit-trail question "what did the driver
  actually see and click?" needs the original wording preserved.
- **Photo polyglots** — attacker uploads a valid-looking JPEG that's
  actually a PDF-in-JPEG polyglot or carries a libvips decompression
  bomb. Served back as an image URL, this is an XSS or DoS vector.
- **Cross-tenant photo access** — tenant A's admin guesses tenant B's
  photo URL, gets an unauthorised body-shot of tenant B's truck.
- **S3_ENDPOINT SSRF** — a misconfigured `S3_ENDPOINT=http://169.254.169.254/`
  (AWS IMDS) turns the upload path into an arbitrary-HTTP tool with
  the photo buffer as the body. Bootstrap must reject private /
  metadata IPs in production.
- **Secrets leaked to logs** — S3 credentials land in an AWS SDK error
  dump. The existing Prisma redactor doesn't know the S3 env-var names.
- **Runaway storage** — a script uploads 10 000 photos to one
  inspection, fills the S3 bucket, costs the operator money.
- **Pre-trip skipped at checkout** — driver checks out a CMV without
  completing the pre-trip. DOT-non-compliant. Compliance-blocking for
  commercial-fleet pilots.
- **Lost-evidence on replay** — soft-deleted photos sit in S3 forever
  between 0.3 ship and 0.4 retention sweep. Move the sweep INTO 0.3.
- **Driver tab-close mid-inspection** — driver closes the tab on a
  partial inspection. Next session: does the launcher show TWO
  IN_PROGRESS rows? Need resume-in-progress semantics.
- **Simultaneous admin review** — two admins open the same FAIL
  inspection, both click "Close review". Last-write-wins is the
  double-approval bug from ADR-0009. Conditional UPDATE.
- **Template edit signal missing** — admin edits a template without
  seeing there are 50 in-flight inspections with the old version.
  UI concern; noted for the web commit.
- **Mixed-fleet template scope** — fleet has 38 standard vehicles +
  2 road-test rigs. "all VEHICLE-kind" + "specific category override"
  must have a clear precedence: categoryId beats categoryKind.

## Prior art

| Pattern | Used by | Works for us? |
|---|---|---|
| **Snapshot-on-start checklist** (snapshot items + labels to JSON on inspection row) | Formbricks, Tally, most form builders | Yes — zero versioning headache |
| Copy-table versioning (new row per version) | Notion databases | Too heavy; <50 templates × ~10 items |
| Live-mutable template (items referenced by id) | Snipe-IT custom fieldsets | No — edits corrupt historical responses |
| Direct-to-S3 presigned uploads | most SaaS w/ photo uploads | Deferred to 1.1+ (mobile); see §Alternatives |
| Proxy-through-API uploads | smaller SaaS / compliance-gated | Yes at 0.3 — server-side EXIF strip BEFORE S3 PUT is the safety property |
| ClamAV scan step | Regulated-industry uploads | Deferred to 0.4 — documented residual risk |
| sharp `.rotate().keepExif(false).keepIccProfile(false).keepMetadata(false)` | Express image-upload tutorials, reviewed post-libvips-CVE history | Yes — explicit (default varies by format + libvips build) |
| `FleetManager/public/vehicle_checkout.php::$inspectionMode=='full'` gate | Amtrak/FDT local bolt-on | The exact pattern we need at tenant scope in Panorama (persona-fleet-ops grounding) |

## Decision

**Five-table inspection domain + snapshot-on-start template versioning +
proxy-through-API photo pipeline with explicit sharp-metadata strip +
`capturedAt` preservation + reservation-tether flag + FAIL-outcome email
subscriber + retention sweep — all in 0.3.** Ten moving parts below.

The architecture prioritises (in order): tenant isolation, compliance
auditability, privacy (EXIF strip), commercial-fleet regulatory fit
(reservation tether), operator ergonomics, schema integrity.

### 1. Inspection domain — five tables (migration 0012)

```prisma
model InspectionTemplate {
  id               String    @id @default(uuid()) @db.Uuid
  tenantId         String    @db.Uuid
  name             String
  description      String?
  /// Scope: categoryKind (all assets of that kind) OR categoryId
  /// (override). Exactly one set, enforced by CHECK constraint.
  /// categoryKind is a deliberate denormalisation — it's a sentinel
  /// that means "any Category in this tenant with kind=X". No FK
  /// exists by design; renaming a category.kind would be a breaking
  /// schema change anyway. Template scope resolution at launcher
  /// time: categoryId beats categoryKind when both could apply.
  /// Integration test asserts this precedence (cross-kind fixture).
  categoryKind     CategoryKind?
  categoryId       String?   @db.Uuid
  /// Display order among templates that match the same scope.
  /// Lower = first. Ties broken by createdAt ASC.
  displayOrder     Int       @default(0)
  /// Soft-archive. Archived templates still render historical
  /// inspections but cannot START new ones.
  archivedAt       DateTime?
  createdByUserId  String    @db.Uuid
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  tenant      Tenant                   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category    Category?                @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  createdBy   User                     @relation(fields: [createdByUserId], references: [id])
  items       InspectionTemplateItem[]
  inspections Inspection[]

  // Index strategy — see §"Index rationale" below.
  // (Partial composites hand-written in migration — Prisma can't model
  // partial indexes.)
  @@map("inspection_templates")
}

// InspectionTrigger enum REMOVED from 0.3.
// Rationale: with 0 call-sites in 0.3, shipping CHECKOUT/CHECKIN
// values is the "helper with three knobs used by one caller" smell.
// 0.4 adds the enum via `ALTER TYPE ... ADD VALUE` migration when the
// reservation-hook design lands with its concrete trigger semantics.
// What stays in 0.3: the `Inspection.reservationId?` FK (the load-
// bearing foothold) and the Tenant.requireInspectionBeforeCheckout
// flag (see §8).

model InspectionTemplateItem {
  id             String   @id @default(uuid()) @db.Uuid
  templateId     String   @db.Uuid
  tenantId       String   @db.Uuid
  position       Int
  label          String
  itemType       InspectionItemType
  required       Boolean  @default(false)
  /// If true and itemType != PHOTO, the item carries BOTH an answer
  /// AND must have at least one photo attached.
  photoRequired  Boolean  @default(false)
  minValue       Float?
  maxValue       Float?
  helpText       String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  tenant   Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  template InspectionTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)

  @@unique([templateId, position])
  @@map("inspection_template_items")
}

enum InspectionItemType {
  BOOLEAN
  TEXT
  NUMBER
  PHOTO
  @@map("inspection_item_type")
}

model Inspection {
  id                String            @id @default(uuid()) @db.Uuid
  tenantId          String            @db.Uuid
  /// onDelete: SetNull preserves inspections if a super-admin
  /// cleanup hard-deletes a template. Snapshot below has the form
  /// shape regardless.
  templateId        String?           @db.Uuid
  /// Template snapshot at start time — immutable.
  /// Shape: { name, description, templateVersionAt (ISO start time),
  /// items: [{ id, position, label, itemType, required, photoRequired,
  /// minValue?, maxValue?, helpText? }] }. Responses reference snapshot
  /// item IDs, not live template_items rows. Validated at write by
  /// Zod; CHECK constraints enforce non-empty items[] + 64 kB cap.
  templateSnapshot  Json
  /// Blocking FK — a tenant cannot hard-delete an asset with
  /// inspection history. Archive instead.
  assetId           String            @db.Uuid
  /// Optional. When set, service verifies reservation.tenantId ==
  /// inspection.tenantId (FKs cross tenants silently otherwise).
  /// onDelete: SetNull so reservation cleanup doesn't orphan history;
  /// the panorama.inspection.* audit chain carries the original ID.
  reservationId     String?           @db.Uuid
  /// onDelete: Restrict — a driver with inspection history blocks
  /// hard-delete of the User row. Soft-delete (User.deletedAt) is
  /// the normal pathway.
  startedByUserId   String            @db.Uuid
  status            InspectionStatus  @default(IN_PROGRESS)
  outcome           InspectionOutcome?
  summaryNote       String?
  startedAt         DateTime          @default(now())
  completedAt       DateTime?
  completedByUserId String?           @db.Uuid
  /// Review lifecycle — admin closes out FAIL / NEEDS_MAINTENANCE.
  /// Writes MUST be conditional on `reviewedAt IS NULL` to prevent
  /// the double-approval bug (two admins clicking Close at once).
  /// reviewNote is appendable post-review (not immutable) — an ops
  /// follow-up 2 days later ("body shop confirmed, returned to
  /// service") is a normal write; an audit event fires on every
  /// reviewNote mutation via `panorama.inspection.review_note_updated`.
  reviewedAt        DateTime?
  reviewedByUserId  String?           @db.Uuid
  reviewNote        String?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  tenant      Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  template    InspectionTemplate? @relation(fields: [templateId], references: [id], onDelete: SetNull)
  asset       Asset               @relation(fields: [assetId], references: [id], onDelete: Restrict)
  reservation Reservation?        @relation(fields: [reservationId], references: [id], onDelete: SetNull)
  startedBy   User                @relation("InspectionStarter",   fields: [startedByUserId],   references: [id], onDelete: Restrict)
  completedBy User?               @relation("InspectionCompleter", fields: [completedByUserId], references: [id], onDelete: SetNull)
  reviewedBy  User?               @relation("InspectionReviewer",  fields: [reviewedByUserId],  references: [id], onDelete: SetNull)
  responses   InspectionResponse[]
  photos      InspectionPhoto[]

  @@map("inspections")
}

enum InspectionStatus {
  IN_PROGRESS
  COMPLETED
  CANCELLED
  @@map("inspection_status")
}

enum InspectionOutcome {
  PASS
  FAIL
  NEEDS_MAINTENANCE
  @@map("inspection_outcome")
}

model InspectionResponse {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String   @db.Uuid
  inspectionId    String   @db.Uuid
  /// References an `id` inside the inspection's templateSnapshot —
  /// NOT a live template_items row. Referential integrity enforced
  /// by a BEFORE-INSERT / BEFORE-UPDATE trigger that validates the
  /// snapshot JSON contains an `items[*].id` matching this value
  /// (see §2). Unique per inspection.
  snapshotItemId  String   @db.Uuid
  booleanValue    Boolean?
  textValue       String?
  numberValue     Float?
  note            String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  inspection Inspection       @relation(fields: [inspectionId], references: [id], onDelete: Cascade)
  photos     InspectionPhoto[]

  @@unique([inspectionId, snapshotItemId])
  @@map("inspection_responses")
}

model InspectionPhoto {
  /// Server-minted UUID. The row PK. Never exposed to the client
  /// as an idempotency handle — the retry-dedup key is
  /// `clientUploadKey` (below). This split closes the v2
  /// existence-oracle that treated PK-collision as "already done"
  /// without checking ownership.
  id               String   @id @default(uuid()) @db.Uuid
  tenantId         String   @db.Uuid
  inspectionId     String   @db.Uuid
  responseId       String?  @db.Uuid
  /// Client-generated UUID sent on the multipart upload; used as
  /// the idempotency handle. Unique scoped to inspectionId so a
  /// retry with the same key returns the already-written row.
  /// Collisions across inspections are irrelevant (different
  /// row owners). Not exposed as PK — see `id` above.
  clientUploadKey  String   @db.Uuid
  /// Object-storage key WITHOUT bucket prefix. Layout:
  ///   tenants/{tenantId}/inspections/{inspectionId}/photos/{photoId}.jpg
  /// UUID-strict CHECK constraint (below) prevents path traversal or
  /// prefix-guessing attacks at the DB layer. The `object-storage.keys.ts`
  /// constant is the sole writer of this value; a round-trip unit test
  /// asserts the constant's output always passes the CHECK.
  storageKey       String
  /// Always "image/jpeg" in 0.3 (sanitise re-encodes everything).
  contentType      String
  sizeBytes        Int
  /// SHA-256 of the SANITISED bytes (post-strip + re-encode).
  sha256           String
  width            Int
  height           Int
  /// Extracted from EXIF DateTimeOriginal BEFORE the strip. Null when
  /// the source had no EXIF date. User-supplied — phones lie — but
  /// strictly more credible than uploadedAt for an insurance hearing
  /// (which is the exact scenario the field exists for). Documented
  /// caveat in inspections.md.
  capturedAt       DateTime?
  /// EXIF / ICC / IPTC / XMP field NAMES found and stripped.
  /// Values never logged or persisted — only the type of metadata.
  /// Examples: ["GPSLatitude", "GPSLongitude", "Make", "Model",
  /// "ICC_Profile", "XMP:Creator"].
  exifStripped     Json     @default("[]")
  status           InspectionPhotoStatus @default(UPLOADED)
  uploadedByUserId String   @db.Uuid
  uploadedAt       DateTime @default(now())
  /// Soft-delete. Retention sweep (0.3 §10) hard-deletes after
  /// Tenant.inspectionPhotoRetentionDays (default 730 / 2 years, min
  /// 30). GDPR Art. 17 right-to-erasure is handled via the super-admin
  /// hard-delete break-glass (§9) — not the retention sweep.
  deletedAt        DateTime?

  inspection Inspection          @relation(fields: [inspectionId], references: [id], onDelete: Cascade)
  response   InspectionResponse? @relation(fields: [responseId], references: [id], onDelete: SetNull)
  uploadedBy User                @relation(fields: [uploadedByUserId], references: [id])

  @@unique([inspectionId, clientUploadKey])
  @@map("inspection_photos")
}

enum InspectionPhotoStatus {
  UPLOADED
  REJECTED
  @@map("inspection_photo_status")
}
```

### Tenant per-template config column (migration 0012)

```prisma
model Tenant {
  // ...existing fields...

  /// Per-tenant inspection policy. Null = defaults. Schema
  /// (Zod-validated at write):
  /// {
  ///   maxPhotosPerInspection?: int 1..100             (default 20)
  ///   maxPhotoBytes?: int 1..25_000_000               (default 10_485_760 = 10 MB)
  ///   maxPhotoDimension?: int 512..4096               (default 2048)
  ///   staleInProgressHours?: int 1..168               (default 24; §9 resume)
  ///   preCheckoutInspectionMaxAgeMinutes?: int 30..1440 (default 240 = 4 h; §8 tether)
  /// }
  /// `requireInspectionBeforeCheckout` is NOT in this shape — it
  /// lives as a dedicated column (below). Single source of truth.
  /// 0.3 reads all fields from this column. The knob ships in
  /// Community; per-tenant override UI for these fields lands in
  /// Enterprise only (ADR-0002; feature-matrix update tracked
  /// alongside this ADR).
  inspectionConfig                  Json?
  /// Photo retention override (days). Null = default 425 days
  /// (DOT 49 CFR §396.3 retains pre-trip records 14 months;
  /// 425 d = 14 mo + 2 mo buffer). Min 30 enforced at the service
  /// layer. This column + the sweep are Community; the per-tenant
  /// override UI is Enterprise.
  inspectionPhotoRetentionDays      Int?
  /// Reservation-tether flag — column-only (NOT duplicated inside
  /// inspectionConfig Zod shape; that footgun removed in v3 per
  /// tech-lead review). When true, ReservationService.checkOut
  /// rejects 409 `inspection_required` unless a COMPLETED+PASS
  /// inspection exists for (asset, user) within
  /// `inspectionConfig.preCheckoutInspectionMaxAgeMinutes` (default
  /// 240 = 4 h). Default false for non-CMV fleets; commercial-
  /// fleet pilots flip on. See §8.
  requireInspectionBeforeCheckout   Boolean @default(false)
}
```

### CHECK constraints + trigger (migration 0012)

```sql
-- Template scope exclusivity.
ALTER TABLE "inspection_templates"
  ADD CONSTRAINT "inspection_templates_scope_exclusive"
  CHECK (
    ("categoryKind" IS NOT NULL AND "categoryId" IS NULL)
    OR
    ("categoryKind" IS NULL AND "categoryId" IS NOT NULL)
  );

-- Storage key MUST be UUID-strict under tenant prefix.
-- Catches any contributor bug producing non-standard keys + closes
-- the path-traversal tail risk (`LIKE` doesn't reject `..`).
ALTER TABLE "inspection_photos"
  ADD CONSTRAINT "inspection_photos_key_uuid_strict"
  CHECK (
    "storageKey" ~ '^tenants/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/inspections/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    AND
    "storageKey" LIKE 'tenants/' || "tenantId"::text || '/%'
  );

-- Response single-answer column rule.
ALTER TABLE "inspection_responses"
  ADD CONSTRAINT "inspection_responses_single_answer"
  CHECK (
    (
      ("booleanValue" IS NOT NULL)::int +
      ("textValue"    IS NOT NULL)::int +
      ("numberValue"  IS NOT NULL)::int
    ) <= 1
  );

-- Status/completion coherent.
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_completed_coherent"
  CHECK (
    (status = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedByUserId" IS NOT NULL)
    OR
    (status <> 'COMPLETED' AND "completedAt" IS NULL AND "completedByUserId" IS NULL)
  );

-- Outcome requires COMPLETED (prevents orphan outcome writes).
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_outcome_coherent"
  CHECK (
    (outcome IS NULL AND status <> 'COMPLETED')
    OR
    (outcome IS NOT NULL AND status = 'COMPLETED')
  );

-- Snapshot size cap — 64 kB. Accommodates ~40 items × ~1600 B/item
-- incl. helpText paragraphs. Too-large snapshots fail with 500; the
-- service-layer Zod validator catches this pre-DB with a 422.
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_snapshot_size_cap"
  CHECK (pg_column_size("templateSnapshot") <= 65536);

-- Snapshot well-formed: must be an object with a non-empty items[].
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_snapshot_well_formed"
  CHECK (
    jsonb_typeof("templateSnapshot" -> 'items') = 'array'
    AND jsonb_array_length("templateSnapshot" -> 'items') > 0
  );

-- inspectionConfig JSON size cap.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_inspection_config_size_cap"
  CHECK (
    "inspectionConfig" IS NULL
    OR pg_column_size("inspectionConfig") <= 2048
  );

-- Retention floor.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_inspection_retention_floor"
  CHECK (
    "inspectionPhotoRetentionDays" IS NULL
    OR "inspectionPhotoRetentionDays" >= 30
  );
```

**Snapshot-immutability trigger** — `BEFORE UPDATE OF "templateSnapshot"`,
RAISE EXCEPTION when the column actually changes. Super-admin break-glass
via a `panorama.*` GUC (namespace matches ADR-0005's
`panorama.bypass_owner_check` precedent):

```sql
CREATE OR REPLACE FUNCTION enforce_inspection_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD."templateSnapshot" IS DISTINCT FROM NEW."templateSnapshot" THEN
    -- Break-glass: operator sets panorama.allow_snapshot_edit='true'
    -- in the transaction. Audit chain catches the tampering regardless
    -- via a separate audit.record call the break-glass code MUST
    -- issue BEFORE the bypass write. Analogue of ADR-0011's
    -- notification tamper trigger.
    IF current_setting('panorama.allow_snapshot_edit', true) = 'true' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'inspection_snapshot_immutable'
      USING ERRCODE = '22023';  -- invalid parameter value
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_inspection_snapshot_immutable_trigger
    ON "inspections";
CREATE TRIGGER enforce_inspection_snapshot_immutable_trigger
    BEFORE UPDATE OF "templateSnapshot" ON "inspections"
    FOR EACH ROW EXECUTE FUNCTION enforce_inspection_snapshot_immutable();
```

**Snapshot-item-ref integrity trigger** — validates
`InspectionResponse.snapshotItemId` references an item inside the
parent inspection's snapshot. Service validates too (fast-path error
messages); DB catches the case where a contributor writes raw SQL.
`SECURITY DEFINER` so the lookup bypasses RLS on the parent
`inspections` row — prevents false-negative raises under a super-
admin break-glass transaction that hasn't also elevated role:

```sql
CREATE OR REPLACE FUNCTION validate_inspection_response_snapshot_ref()
RETURNS trigger
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM inspections,
         jsonb_array_elements(inspections."templateSnapshot" -> 'items') AS item
    WHERE inspections.id = NEW."inspectionId"
      AND (item ->> 'id')::uuid = NEW."snapshotItemId"
  ) INTO found;
  IF NOT found THEN
    RAISE EXCEPTION 'inspection_response_snapshot_ref_invalid'
      USING ERRCODE = '23503';  -- foreign_key_violation (semantically)
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function owner is panorama_super_admin (migration runs as super-
-- admin); SECURITY DEFINER means the function executes with owner
-- privileges regardless of calling role. Combined with explicit
-- `search_path` this is the standard Postgres security-definer
-- pattern.
ALTER FUNCTION validate_inspection_response_snapshot_ref()
  OWNER TO panorama_super_admin;

CREATE TRIGGER validate_inspection_response_snapshot_ref_trigger
    BEFORE INSERT OR UPDATE OF "snapshotItemId" ON "inspection_responses"
    FOR EACH ROW EXECUTE FUNCTION validate_inspection_response_snapshot_ref();
```

**RLS** (rls.sql companion file to migration.sql, mirrors ADR-0003 +
ADR-0011 pattern — every table pairs `ENABLE` with `FORCE` so a
maintenance script running as the table owner without an explicit
`RESET ROLE` still gets the policy applied; security-reviewer
v2 blocker):

```sql
ALTER TABLE inspection_templates      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inspection_templates      FORCE   ROW LEVEL SECURITY;
ALTER TABLE inspection_template_items ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inspection_template_items FORCE   ROW LEVEL SECURITY;
ALTER TABLE inspections               ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inspections               FORCE   ROW LEVEL SECURITY;
ALTER TABLE inspection_responses      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inspection_responses      FORCE   ROW LEVEL SECURITY;
ALTER TABLE inspection_photos         ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inspection_photos         FORCE   ROW LEVEL SECURITY;

-- (5× policies — same predicate, one per table)
CREATE POLICY <table>_tenant_isolation
  ON <table>
  FOR ALL TO panorama_app
  USING ("tenantId" = panorama_current_tenant())
  WITH CHECK ("tenantId" = panorama_current_tenant());
```

### Index rationale (hand-written partials in migration; Prisma can't model)

```sql
-- inspection_templates
-- Launcher (by kind) — matches scope exclusivity.
CREATE INDEX ON "inspection_templates"
  ("tenantId", "categoryKind", "displayOrder")
  WHERE "archivedAt" IS NULL AND "categoryKind" IS NOT NULL;

-- Launcher (by category override).
CREATE INDEX ON "inspection_templates"
  ("tenantId", "categoryId", "displayOrder")
  WHERE "archivedAt" IS NULL AND "categoryId" IS NOT NULL;

-- Admin "archived" list — falls back to seq scan (tens of rows/tenant).

-- inspections
-- Last-N for an asset (asset-detail page, most-frequent query).
CREATE INDEX ON "inspections"
  ("tenantId", "assetId", "startedAt" DESC);

-- My open inspections (driver-home).
CREATE INDEX ON "inspections"
  ("tenantId", "startedByUserId")
  WHERE status = 'IN_PROGRESS';

-- Admin needs-review (FAIL / NEEDS_MAINTENANCE + unreviewed).
CREATE INDEX ON "inspections"
  ("tenantId", "startedAt" DESC)
  WHERE status = 'COMPLETED' AND "reviewedAt" IS NULL;

-- Reservation-link lookup (tether check).
CREATE INDEX ON "inspections"
  ("tenantId", "reservationId")
  WHERE "reservationId" IS NOT NULL;

-- inspection_template_items
-- Only UNIQUE(templateId, position) — no bare (tenantId) index
-- (data-architect review: dead index, ~500 rows total).

-- inspection_responses
-- Only UNIQUE(inspectionId, snapshotItemId) — RLS predicate plus
-- the UNIQUE covers every read pattern (data-architect review).

-- inspection_photos
-- Per-inspection gallery.
CREATE INDEX ON "inspection_photos" ("tenantId", "inspectionId")
  WHERE "deletedAt" IS NULL;

-- Per-response lookup (partial on not-null responseId; ~60% of
-- photos are response-linked in practice).
CREATE INDEX ON "inspection_photos" ("tenantId", "responseId")
  WHERE "responseId" IS NOT NULL AND "deletedAt" IS NULL;

-- Retention-sweep scan (0.3 §10 sweep job).
CREATE INDEX ON "inspection_photos" ("deletedAt")
  WHERE "deletedAt" IS NOT NULL;
```

The "tenant-wide recent photos" index the v1 draft included is dropped
— no endpoint backs it. Add alongside the endpoint migration if one
ships.

### 2. Snapshot-on-start template versioning

When an inspection starts, the service reads the live
`InspectionTemplate` + ordered items and writes the ORDERED ITEM LIST
(plus template name + description + a `templateVersionAt` ISO timestamp)
into `Inspection.templateSnapshot`. Every response references an `id`
inside that snapshot.

Enforcement — four layers:

1. **Service-layer Zod** validates shape + size on write (fast-path 422).
2. **CHECK constraint** `inspections_snapshot_well_formed` rejects
   missing items[] or empty array.
3. **CHECK constraint** `inspections_snapshot_size_cap` rejects > 64 kB.
4. **Trigger** `enforce_inspection_snapshot_immutable` rejects any
   UPDATE that changes the column.

**Break-glass** — super-admin transactions that `SET LOCAL
app.allow_snapshot_edit = 'true'` bypass the trigger for repair
scenarios (sharp regression writes malformed snapshot before any
responses exist). The break-glass code MUST emit
`panorama.inspection.snapshot_edited` audit-of-intent before the
bypass write so the hash-chain captures the rationale. No product
code path uses this; break-glass is operator-only.

**Template-change visibility on review** — the review UI reads
`Inspection.templateSnapshot.templateVersionAt` and compares against
`InspectionTemplate.updatedAt`. When they differ, the review form
shows "Template has been edited since this inspection started
(snapshot preserved)". Product-lead / persona-fleet-ops requirement;
closes the "admin confused by edits" scenario.

### 3. Object storage — `ObjectStorageModule` + MinIO / S3

One Nest module, one injectable service. AWS SDK v3
(`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`). Config via env
(read + validated at bootstrap; fail-fast):

| Env | Default | Notes |
|---|---|---|
| `S3_ENDPOINT` | unset (real AWS) | `http://localhost:9000` for MinIO. **SSRF-validated at bootstrap** — see below. |
| `S3_REGION` | `us-east-1` | MinIO ignores. |
| `S3_BUCKET_PHOTOS` | required | fail-fast at bootstrap |
| `S3_ACCESS_KEY` | required | aligns with existing `.env.example:22` |
| `S3_SECRET_KEY` | required | aligns with existing `.env.example:23` |
| `S3_FORCE_PATH_STYLE` | `false` prod, `true` MinIO | |
| `S3_SIGNED_URL_TTL_SECONDS` | `300` | detail view; list-page thumbnails override to 60 s |
| `FEATURE_INSPECTIONS` | `false` first release, `true` after canary validation | Gates InspectionModule at bootstrap. Same flag pattern as `FEATURE_SNIPEIT_COMPAT_SHIM`. |

**Bootstrap SSRF validation** — `ObjectStorageService.onModuleInit`
performs a DNS resolve of the endpoint hostname and rejects if ANY
A/AAAA answer (not just the first) falls into:

- `169.254.0.0/16` (AWS IMDS + link-local)
- `127.0.0.0/8`, `::1` (loopback; allowed only when `NODE_ENV=development` + `S3_ALLOW_PRIVATE_ENDPOINT=true` for MinIO dev)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918)
- `fc00::/7` (IPv6 unique-local)

And rejects hostname suffix matches:
- `metadata.google.internal`
- `metadata.azure.com`
- `.internal`, `.local`, `.localdomain`

String-match on hostname alone is bypassable (`attacker.example.com`
with an A-record at `169.254.169.254`); resolve-then-check every
answer is the correct shape. The DNS lookup is cached for the life
of the process — subsequent rebinds to a malicious IP are foiled
because the SDK reuses the cached IP (AWS SDK v3 behaviour).

Prod `S3_ENDPOINT` must be `https://`. Dev-only escape hatch
(`S3_ALLOW_PRIVATE_ENDPOINT=true`) permits http://minio for the local
stack. The AWS SDK HTTP handler is configured with `followRedirects:
false` regardless.

Bootstrap emits one audit event `panorama.boot.object_storage_configured`
with `{ endpoint: <resolved-host>, bucket, region, forcePathStyle,
ttlSeconds }` (no secrets). Production operators verify this row to
rule out endpoint drift.

**Secrets hygiene** — all three env keys (`S3_ENDPOINT` not secret but
key pair is) are added to the Prisma redactor via two layers:

1. `PRISMA_REDACT_FIELDS` (at `apps/core-api/src/modules/prisma/prisma.service.ts:28`)
   gains `accessKeyId`, `secretAccessKey`, `AccessKeyId`,
   `SecretAccessKey`, `authorization`, and their SCREAMING_SNAKE variants
   (including the `.env.example` names `S3_ACCESS_KEY` and
   `S3_SECRET_KEY`). The `authorization` field catches the
   Authorization header that sometimes appears in SDK diagnostic dumps.
   Redaction is field-name-based, so the AWS SDK v3 error chain's
   `accessKeyId` key is caught.
2. A one-liner `AppLogger` wrapper (new, ships in this module) pipes
   every `this.log.error()` through the same redactor before passing
   to Nest's Logger. Unit test asserts a simulated SDK failure carrying
   `accessKeyId: "AKIA..."` yields `<redacted>` in the captured output.

**Service surface** (`ObjectStorageService`):

```typescript
put(key: string, body: Buffer, opts: { contentType: string; sha256: string }): Promise<void>;
getSignedUrl(
  key: string,
  opts?: { expiresIn?: number; thumbnail?: boolean }
): Promise<string>;  // GET only
delete(key: string): Promise<void>;
/** Defence-in-depth — throws if `key` is not under `tenants/{tenantId}/`. */
assertKeyForTenant(key: string, tenantId: string): void;
```

Key layout centralised in `object-storage.keys.ts`:

```typescript
export const inspectionPhotoKey = (
  tenantId: string,  // runtime-validated UUID
  inspectionId: string,
  photoId: string,
) => `tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}.jpg`;
```

All arguments are runtime-validated (`zod.string().uuid()`) so
non-UUID paths cannot be produced. A unit test round-trips this
helper's output through a regex matching the DB CHECK to prove the
invariant.

**Bucket private; no public read.** Browser reads go through
`GET /inspections/:id/photos/:photoId`:

1. `runInTenant(ctx.tenantId, tx => ...)` load — **mandatory**. Inspection
   module is forbidden from calling `runAsSuperAdmin` except when
   writing audit rows (existing `AuditService.record` pattern, which
   itself writes outside the current tenant context). This is the
   architectural commitment that makes RLS the load-bearing isolation
   layer, not a "belt-and-braces" afterthought.
2. Service assertion `if (photo.tenantId !== ctx.tenantId) throw
   new NotFoundException()` (404, not 403, no existence leak).
3. `assertKeyForTenant(row.storageKey, ctx.tenantId)` — runs the full
   UUID-strict regex `^tenants/{uuid}/inspections/{uuid}/photos/{uuid}\.jpg$`,
   NOT a weaker `startsWith('tenants/' + tenantId)` check. Mirrors
   the DB CHECK exactly so a key built by a hypothetical
   `$executeRawUnsafe` path can't pass the service check while
   failing the DB check.
4. `panorama.inspection.photo.viewed` audit (dedup-per-minute via
   Redis `SET NX EX 60` on key `audit:photo-view:{userId}:{photoId}:{viewKind}`
   where `viewKind ∈ {list, detail}` — list thumbnails get a 300 s
   dedup window, detail view gets 60 s. Forensic question "did admin
   open the photo or just see a thumbnail" answerable from the
   audit stream).
5. `res.setHeader('Referrer-Policy', 'no-referrer')`.
6. `res.setHeader('Cache-Control', 'private, no-store')`.
7. Signed URL minted with `ResponseContentDisposition: 'attachment'` +
   `ResponseContentType: 'image/jpeg'` so any byte that somehow slipped
   sanitise cannot be interpreted as HTML by the browser.
8. `302 Location: <signedUrl>`.

List-page thumbnails get 60 s TTL; detail view gets 300 s. Both
substantially shorter than the photo's useful life — leaked URLs
expire quickly.

**Server-side bucket encryption (SSE-AES256)** committed on the bucket
in `infra/terraform/s3.tf` (Enterprise) and `infra/docker/mc-init.sh`
(dev). Bucket creation is idempotent; encryption is non-optional.

### 4. Photo pipeline — proxy-through-API + sharp sanitise

Upload contract:

- **Method + path**: `POST /inspections/:id/photos`
- **Body**: `multipart/form-data` with parts `clientUploadKey`
  (client-generated UUID; used strictly as the idempotency handle,
  never as row PK) and `photo` (binary). Optional part `responseId`
  links to an item answer.
- **Idempotency**: retry with the same `clientUploadKey` + same
  `inspectionId` returns the already-written row. DB uniqueness is
  `(inspectionId, clientUploadKey)` — scoped so a collision across
  inspections is structurally impossible. On 23505 (unique_violation),
  the service loads the existing row, verifies
  `uploadedByUserId == ctx.userId` (ownership match), and returns
  the row. A mismatch audits `panorama.inspection.photo.rejected`
  with `reason='upload_key_collision'` and returns 409 — closes the
  existence-oracle that v2 had. Pipeline ordering is "sanitise →
  S3 PUT → row insert"; a retry after partial failure re-sanitises +
  re-PUTs (idempotent on the key) + tries the row insert again.
- **Auth**: session required. Permitted if:
  - `inspection.tenantId === session.currentTenantId` AND
  - `inspection.startedByUserId === session.userId`
    OR `session.currentRole IN ('owner', 'fleet_admin', 'fleet_staff')`
- **Rate limit**: Redis `RateLimiter` (existing fails-closed limiter at
  `modules/redis/rate-limiter.ts`, mirrors ADR-0008 pattern):
  - per-user: 20 uploads/hour (matches per-inspection cap)
  - per-tenant: 200 uploads/hour
  Hits return 429 `rate_limited`. The in-memory `ThrottlerGuard` stays
  as an outer belt for basic abuse (`@Throttle({ upload: { ttl: 60_000,
  limit: 5 } })`) but the Redis limiter is the authoritative cap.
  Ingress-level size limit (nginx/ALB) at 11 MB is documented in
  `infra/helm` and `docs/en/ops/deploy.md`; Multer's 10 MB is the
  in-process belt-and-braces.

Server pipeline (in order; failure aborts before any side-effect):

1. **Content-length + Multer cap** — 10 MB. Oversize → 413 rejected
   BEFORE body buffered.
2. **Per-inspection photo cap** — inspection's tenant config
   `maxPhotosPerInspection` (default 20). Counted in the upload
   transaction at Serializable isolation so two concurrent uploads
   that would both cross the cap retry + one loses (Prisma P2034 →
   `runTxWithRetry` existing at `PrismaService`). Pattern mirrors
   reservation basket creation (ADR-0009).
3. **Magic-byte sniff** — `file-type` inspects first bytes, matches
   MIME **and** extension. Accept:
   `['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']`.
   Reject everything else 415 `unsupported_media_type`.
4. **EXIF metadata breadcrumb** — read-only `sharp(buf,
   { limitInputPixels: 24_000_000, sequentialRead: true }).metadata()`
   captures field NAMES present (values never read). Parallel branch
   reads `DateTimeOriginal` via `exifr` (pure-JS parser — isolated
   from libvips memory model, so a malformed-EXIF fuzz input can't
   take a photo down through sharp) wrapped in try/catch that
   swallows parse errors and writes `capturedAt: null`. Best-effort:
   phones sometimes lie, missing value writes null.
5. **Sanitise** — sharp pipeline:
   ```typescript
   sharp(buf, { limitInputPixels: 24_000_000, sequentialRead: true })
     .rotate()
     .resize({
       width: cfg.maxPhotoDimension,  // default 2048
       height: cfg.maxPhotoDimension,
       fit: 'inside',
       withoutEnlargement: true,
     })
     .jpeg({ quality: 85, mozjpeg: false })  // mozjpeg OFF — libvips build
     .keepExif(false)                        // explicit
     .keepIccProfile(false)                  // explicit
     .keepMetadata(false)                    // defense in depth
     .toBuffer();
   ```
   `mozjpeg: false` because the Alpine-libvips default build doesn't
   ship mozjpeg; enabling it silently falls back to libjpeg and the
   documented encoder choice doesn't match reality. Libjpeg is fine.
   The three explicit `keep*(false)` calls require sharp ≥ 0.33;
   package.json **exact-version pin** `"sharp": "0.33.2"` (not
   caret) prevents a silent minor upgrade from silently losing the
   API. A CI regression guard asserts zero-metadata output on the
   fixture set and fails the build if a sharp upgrade changes the
   behaviour.
6. **Format integrity** — sharp's re-encode defeats image-format
   polyglots (a JPEG-in-PDF doesn't survive pixel-data round trip).
   Residual risks documented in §7.
7. **SHA-256** over sanitised buffer. Stored; not used for cross-
   tenant dedup (scope-creep risk — keep tenant-local).
8. **S3 PUT** via `ObjectStorageService.put(key, buffer, { contentType:
   'image/jpeg', sha256 })`. Key is built via `inspectionPhotoKey`;
   `assertKeyForTenant(key, ctx.tenantId)` runs before the call.
9. **DB write + audit** — `InspectionPhoto.create` inside the tx;
   `audit.recordWithin(tx, 'panorama.inspection.photo.uploaded', ...)`
   with `{ photoId, inspectionId, reservationId: inspection.reservationId,
   sizeBytes, sha256, width, height, exifStripped, capturedAt: ... }`.
10. **Response** — 201 with photo row + presigned GET URL.

**Failure mapping**:

- `sharp.metadata()` or sanitise throws → 400 `photo_processing_failed`;
  error class name only (never the libvips raw message). Audit
  `panorama.inspection.photo.processing_failed` with `{ reason,
  errorClass }`.
- `limitInputPixels` exceeded → 400 `photo_too_large_pixels`; audit
  `processing_failed` with `reason: 'limit_input_pixels'`. Prevents
  decompression-bomb DoS.
- S3 PUT fails → 500 `storage_write_failed`; no row written; client
  retries safely with same photoId.
- DB write fails after S3 PUT succeeded → retry deletes the orphan
  S3 object on retry (key overwrite is idempotent; old bytes gone).

### 5. Tenant isolation — four-layer contract

1. **RLS on all five tables** — `tenantId = panorama_current_tenant()`.
   **Load-bearing.** Layers 2-4 are additional, not "primary"; layer 1
   must always hold.
2. **Mandated `runInTenant` for inspection reads/writes.** Inspection
   module is architecturally forbidden from calling
   `runAsSuperAdmin` except in the specific sub-call of
   `AuditService.record` (which runs outside tenant context by design,
   per ADR-0003 §audit). A lint rule in the module scaffolding
   (`*.service.ts` head comment) + a review-time grep gate catches
   violations. Integration test bypasses the service (direct Prisma
   + bogus tenant GUC) to confirm RLS blocks cross-tenant SELECT on
   every inspection table.
3. **Service-layer assertion** — `if (row.tenantId !== ctx.tenantId)
   throw new NotFoundException()`. Runs after RLS, so it catches the
   (should-be-impossible) case where RLS returned a row under an
   unexpected tenant GUC.
4. **`assertKeyForTenant`** — storage-key prefix verified before any
   presigned-URL mint or delete.
5. **Private bucket + presigned URL** — TTL 60/300 s, scoped to exact
   key, `Referrer-Policy: no-referrer`, `Cache-Control: private,
   no-store`, `ResponseContentDisposition: attachment`.

### 6. Audit events

| Action | When | Metadata |
|---|---|---|
| `panorama.inspection.template.created` | Admin creates | templateId, name, scope (kind/categoryId) |
| `panorama.inspection.template.updated` | Admin edits | templateId, changedFields |
| `panorama.inspection.template.archived` | Admin archives | templateId |
| `panorama.inspection.started` | Driver/admin starts | inspectionId, assetId, templateId, reservationId?, snapshotItemCount, templateVersionAt |
| `panorama.inspection.resumed` | Driver resumes IN_PROGRESS | inspectionId, secondsSinceStarted |
| `panorama.inspection.completed` | Driver/admin finishes | inspectionId, outcome, responseCount, photoCount, summaryNote, reservationId? |
| `panorama.inspection.reviewed` | Admin closes out | inspectionId, reviewerUserId, reviewNote, outcome |
| `panorama.inspection.review_note_updated` | Admin appends post-review | inspectionId, prevLen, newLen |
| `panorama.inspection.cancelled` | Driver/admin cancels | inspectionId, reason |
| `panorama.inspection.auto_cancelled` | Stale-sweep cron | inspectionId, reason='auto_cancel_stale', hoursStale |
| `panorama.inspection.snapshot_edited` | Super-admin break-glass | inspectionId, operatorUserId, rationale |
| `panorama.inspection.photo.uploaded` | After sanitise + PUT + row | photoId, inspectionId, reservationId?, sizeBytes, sha256, exifStripped, capturedAt? |
| `panorama.inspection.photo.rejected` | Pre-PUT rejection | inspectionId, reason (`oversize` / `unsupported_type` / `rate_limited`) |
| `panorama.inspection.photo.processing_failed` | sharp/libvips failure | inspectionId, reason, errorClass |
| `panorama.inspection.photo.viewed` | Presigned-URL mint (de-duped per user+photo+minute) | photoId, inspectionId, viewerUserId, ttlSeconds, ipHash |
| `panorama.inspection.photo.deleted` | Soft-delete | photoId, reason |
| `panorama.inspection.photo.hard_deleted` | Retention sweep or break-glass | photoId, reason ('retention_sweep' / 'gdpr_erasure'), operatorUserId? |
| `panorama.boot.object_storage_configured` | Bootstrap | endpoint host, bucket, region, forcePathStyle, ttlSeconds |

### 7. Residual security risks (documented, accepted at 0.3)

0.3 accepts the following risks with the listed compensating controls.
0.4 ships the deferred mitigations.

- **Steganographic / pixel-data payloads** — sharp re-encoding
  preserves pixel data (the sanitation is metadata-level). A
  compromised driver endpoint could embed data in pixel noise. Blast
  radius: data exfil via photo bytes, no server-side execution. 0.3
  control: none specific; 0.4 adds ClamAV + content-aware detection.
- **libvips 0-day RCE during sanitise** — libvips / ImageMagick have
  had historical CVEs (ImageTragick). 0.3 controls: `limitInputPixels:
  24_000_000`, `sequentialRead: true`, rate limits on upload,
  stateless API workers (restart cheap). Blast radius: one worker
  compromise, no cross-tenant data (RLS still holds in-process).
- **Decompression bombs beyond `limitInputPixels`** — a crafted
  200×200 image that expands to 100M pixels triggers `limitInputPixels`
  and returns 400. Controlled.
- **Image-format polyglots** — defeated by sharp pixel-data
  re-encode to JPEG.
- **ClamAV malware scan** — deferred to 0.4. Release notes + ops doc
  explicitly name the gap so regulated-industry pilots can assess.
- **No content-integrity attestation at 0.3** — sha256 in the row,
  but no signed manifest. 0.4 adds a per-tenant HMAC key +
  `inspection.signedManifest` on completion.

### 8. Reservation tether (0.3 scope)

Commercial-fleet compliance (DOT 49 CFR §396.11) requires a pre-trip
inspection report on CMV operation. Shipping 0.3 without a
reservation-tether flag is non-viable for Amtrak/FDT-shape pilots
(persona-fleet-ops review, §8 "Reservation integration deferred"
rejected).

**Schema** — `Tenant.requireInspectionBeforeCheckout: Boolean @default(false)`
(migration 0012). Default off preserves current reservation UX for
non-CMV fleets (Community's "the full reservation flow is always
complete" commitment, `feature-matrix.md:32-39`).

**Behaviour** — when the flag is on, `ReservationService.checkOut`:

1. Queries `inspections` for the latest `COMPLETED + PASS` inspection
   with `(tenantId, assetId, startedByUserId)` matching the checkout
   actor AND `completedAt >= now() - interval '4 hours'`. The 4 h
   window is the policy default; documented knob for per-tenant
   override at 0.4.
2. If none found → 409 `inspection_required`, audit
   `panorama.reservation.checkout_blocked` with
   `{ reason: 'inspection_required', assetId, userId }`.
3. If found → proceed; record the inspectionId in the checkout audit
   metadata (`preCheckoutInspectionId`).

**Module coupling — Reservation reads `inspections` table directly
through Prisma; NO `InspectionService` import.** v2 proposed
`ReservationService.checkOut` consume
`InspectionService.latestPassForCheckout`. Tech-lead v2 review
correctly flagged this as a cross-domain service-to-service
dependency that ADR-0011 §paragraph-272 explicitly bans ("the
invariant there bans reaching into OTHER domain modules' services
— e.g. `ReservationService` importing `InvitationService`").

The replacement pattern: Reservation's checkout path runs the
single-table query directly:

```typescript
// In ReservationService.checkOut, inside the existing runInTenant
// transaction. No new module dependency.
const tenant = await tx.tenant.findUnique({
  where: { id: actor.tenantId },
  select: {
    requireInspectionBeforeCheckout: true,
    inspectionConfig: true,
  },
});
if (tenant?.requireInspectionBeforeCheckout) {
  const cfg = parseInspectionConfig(tenant.inspectionConfig);
  const cutoff = new Date(
    Date.now() - cfg.preCheckoutInspectionMaxAgeMinutes * 60_000,
  );
  const passed = await tx.inspection.findFirst({
    where: {
      tenantId: actor.tenantId,
      assetId: reservation.assetId,
      startedByUserId: actor.userId,
      status: 'COMPLETED',
      outcome: 'PASS',
      completedAt: { gte: cutoff },
    },
    select: { id: true },
  });
  if (!passed) {
    await this.audit.recordWithin(tx, {
      action: 'panorama.reservation.checkout_blocked',
      resourceType: 'reservation',
      resourceId: reservation.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      metadata: { reason: 'inspection_required', assetId: reservation.assetId },
    });
    throw new ConflictException('inspection_required');
  }
  // Record the pre-checkout inspection in the audit trail.
  reservation_checkout_audit_metadata.preCheckoutInspectionId = passed.id;
}
```

Why this is NOT a boundary violation: Prisma's generated client is
schema-wide. `ReservationService` already queries `tenant`, `asset`,
`reservation`, `blackoutSlot` via `tx.*.findX()` — adding
`tx.inspection.findFirst()` is structurally equivalent. No new
module import, no service-to-service coupling graph, no chance of
circular dependency. The query itself is trivial (one indexed
lookup) and is read-only.

The cost: the query shape is now duplicated in two places if
InspectionService ever also needs it (not in 0.3). If that emerges
at 0.4, the narrow helper moves into a shared `@panorama/shared`
util that both domain services call — NOT into either module's
service. Documented commitment.

This choice is also reversible: if tether logic grows richer (e.g.
per-role overrides, vehicle-class rules), we re-open the design
question at 0.4 — probably via a pre-checkout hook registry
pattern that both modules register against, matching ADR-0011's
`ChannelRegistry` shape. Not premature at 0.3.

**Start-inspection button from reservation** — the reservation
checkout/checkin pages gain a "Start pre-trip inspection" (or
"post-trip") button that navigates to `/inspections/new?asset={id}&
reservation={id}` with the reservation id pre-filled. This is the
primary driver flow; standalone inspections are secondary. 0.3 ships
both.

**Why this stays a boolean and not a per-template enum** — the
`InspectionTrigger` enum (CHECKOUT / CHECKIN) is explicitly dropped
at 0.3 because trigger semantics at 0.4 may need richer conditions
(per-category, per-role, scheduled). The boolean is sufficient for
the compliance case without committing a premature enum.

### 9. Inspection lifecycle — resume + stale cancellation

**Resume-in-progress.** Launcher `/inspections/new?asset=X` first
checks for an `IN_PROGRESS` inspection with `(tenantId, startedByUserId
= ctx.userId, assetId, startedAt >= now() - inspectionConfig.staleInProgressHours)`.
If found, redirect the driver to that inspection instead of starting
a fresh one — prevents the "driver closed tab, opened later, got two
IN_PROGRESS rows" scenario. Emits `panorama.inspection.resumed`.

**Stale-in-progress auto-cancel.** Maintenance cron (shares the
invitation-maintenance worker's cron hook, same as ADR-0011 retention
sweep) scans `inspections WHERE status = 'IN_PROGRESS' AND startedAt <
now() - inspectionConfig.staleInProgressHours * 3`. Flips to
`CANCELLED` with `reason: 'auto_cancel_stale'`. Photos attached to
the cancelled row persist (soft-delete + retention sweep decides when
they go).

**CANCELLED preserves responses.** Cancelled rows keep their
InspectionResponse + InspectionPhoto for audit. Admin review queue
filters `status = COMPLETED` by default, cancelled out of view unless
explicitly queried.

**GDPR Art. 17 right-to-erasure.** Super-admin break-glass CLI:
`panorama inspection-erase --photo-id <uuid> --reason "<ticket>"`:

1. Sets `panorama.allow_snapshot_edit = 'true'` (same GUC; also
   gates the hard-delete path). `panorama.*` namespace per v3
   consistency.
2. Emits `panorama.inspection.photo.hard_deleted` audit BEFORE the
   write (hash-chain integrity) with `reason: 'gdpr_erasure'`.
3. Deletes the S3 object via `ObjectStorageService.delete`.
4. Hard-deletes the `InspectionPhoto` row.

**DSAR SLA for 0.3** — operator actions the CLI within 30 days of
DSAR intake. This is the contract-level commitment surfaced to
pilot customers.

**0.4 commitment — tenant-admin self-serve hard-delete UI.** For
self-hosted tenants acting as data controllers for their own
drivers, the tenant admin must be able to action driver DSARs
without escalating to the Panorama operator. 0.4 ships a
`/admin/inspection-photos/:id/erase` surface that mirrors the
super-admin CLI behaviour (audit-before-write, S3 delete, row
hard-delete) but scoped to the tenant admin's own tenant via RLS.
Recorded as a firm 0.4 commitment.

Standard soft-delete + retention-sweep handles routine deletion.

### 10. Retention sweep (ships in 0.3)

Maintenance cron runs daily. Scans:

```sql
-- Default retention 425 days = DOT 49 CFR §396.3 14-month floor +
-- 2-month buffer. Previously 730 d; dropped to 425 per tech-lead
-- v2 data-minimisation note. Per-tenant override column supports
-- stricter defaults (30 d minimum).
SELECT id, "storageKey" FROM inspection_photos
 WHERE "deletedAt" IS NOT NULL
   AND "deletedAt" < now() - (
     coalesce(
       (SELECT "inspectionPhotoRetentionDays" FROM tenants WHERE id = inspection_photos."tenantId"),
       425
     ) || ' days'
   )::interval
 LIMIT 500;
```

For each row: `ObjectStorageService.delete(storageKey)` (idempotent;
absence is success), then `DELETE FROM inspection_photos WHERE id =
?`. Audit `panorama.inspection.photo.hard_deleted` with
`reason: 'retention_sweep'`.

Batch size 500 bounds the per-run load. A tenant with 500 k
soft-deleted photos clears at ~500/day; acceptable because retention
is a floor, not a ceiling. Metrics exported to `/metrics` (Prometheus
0.4) so ops sees sweep throughput.

### 11. Notification integration — first subscriber at 0.3

Reserved `panorama.inspection.completed` event schema in
`notification-events.schema.ts`:

```typescript
'panorama.inspection.completed': z.object({
  inspectionId: z.string().uuid(),
  assetId: z.string().uuid(),
  reservationId: z.string().uuid().nullable(),
  startedByUserId: z.string().uuid(),
  outcome: z.enum(['PASS', 'FAIL', 'NEEDS_MAINTENANCE']),
  photoCount: z.number().int().min(0).max(50),
  responseCount: z.number().int().min(0).max(100),
  summaryNote: z.string().max(500).optional(),
}).strict(),
```

**Subscriber at 0.3**: `InspectionOutcomeEmailChannel` — reacts to
`outcome=FAIL | NEEDS_MAINTENANCE`, emails all users with role
`owner | fleet_admin` in the tenant. Reuses `EmailChannel` pattern
from ADR-0011; identical template infrastructure. Body includes
`reservationId` link + inspection summary + review URL.

Why 0.3 not 0.4 (persona-fleet-ops blocker): a driver completing a
FAIL pre-trip and ops finding out only when someone refreshes the
dashboard is a safety gap. Email to ops closes the loop.

### 12. Feature flag + rollout

`FEATURE_INSPECTIONS=false` is the first-release default. Ship dark;
flip to `true` per-tenant via env override on a canary deployment;
after two stable releases (0.3.x / 0.3.y) the default flips to `true`
in the Community distribution. Same dark-launch pattern as
`FEATURE_SNIPEIT_COMPAT_SHIM`.

## Alternatives considered

### Direct-to-S3 presigned uploads at 0.3

Client gets a presigned PUT URL, uploads directly to S3, confirms via
API.

Rejected for 0.3:

- EXIF strip must happen before persistence — with presigned PUT,
  raw EXIF-laden objects sit in S3 between PUT and confirm, visible
  to anyone with a URL leak inside the TTL window.
- Polyglot defence is weaker — we'd fetch from S3, sharp it, write
  back, track dual states.
- 0.3 photo volume is low (~500 MB/day peak per tenant); API CPU
  absorbs it.
- Mobile-offline is the real presigned-upload win; 1.1+ mobile work
  adds the direct-upload codepath under a feature flag.

### Live-mutable template (no snapshot)

Rejected: audit question "what did the driver actually see and click?"
is unanswerable. Same mistake Snipe-IT made.

### Copy-table template versioning

`inspection_template_versions` row per published version.

Rejected: heavy for 0.3 scale. Snapshot gives the same integrity with
one JSON column.

### Keep raw + sanitised side-by-side

Rejected: the raw file IS the leak. Delete aggressively.

### ClamAV in-pipeline scan

Rejected at 0.3 (deferred to 0.4): ops dependency + 200 ms latency
per upload. 0.3 residual-risk table (§7) documents the gap.

### `InspectionTrigger` enum at 0.3

v1 draft shipped this; dropped at v2 per tech-lead + product-lead
review. Zero call sites in 0.3; trigger semantics at 0.4 likely need
richer shape (schedule, per-role). `ALTER TYPE ... ADD VALUE` is the
0.4 migration when that design lands.

### `categoryKind` FK to `Category.kind` enum

Rejected (tech-lead blocker #1 note): `categoryKind` is a denormalised
sentinel that means "any Category in this tenant with kind=X". No row
FK exists by design. Renaming a category.kind value would be a breaking
schema change in any case. Integration test covers the re-keyed-
category-doesn't-orphan-scope invariant.

### BullMQ-backed async sanitise

Rejected: introduces a "photo exists but isn't safe yet" state the UI
has to handle. Synchronous sanitise at 2 MB × 500 ms is absorbed by
the request.

### Per-item translation in 0.3

Rejected at 0.3 scope. Template item labels are tenant-authored
free-text in the tenant's locale. 0.4 adds
`InspectionTemplateItem.translations: Json?` when a mixed-language-
fleet pilot needs it. Persona-fleet-ops flagged this — it stays a
known 0.4 commitment, not a 0.3 ship-blocker.

## Consequences

### Positive

- **Zero EXIF leak** (explicit sharp `keepExif/keepIccProfile/keepMetadata(false)`,
  fixture test with exiftool round-trip, audit breadcrumb of stripped
  fields).
- **Shutter-time preservation via `capturedAt`** — insurance
  defensibility without keeping GPS / owner fields.
- **DOT-compliant reservation tether** — flag-gated so non-CMV fleets
  don't pay the UX cost.
- **Inspection response integrity across template edits** (snapshot).
- **Defence-in-depth on tenant isolation** — four layers, first two
  (RLS + mandated `runInTenant`) architecturally enforced, not
  advisory.
- **S3-compatible, deploy-agnostic.**
- **Audit-complete trail** including photo viewed, processing
  failures, snapshot edits, retention sweeps, bootstrap config.
- **Retention sweep at 0.3** — no orphan-storage pilot footgun.
- **FAIL-outcome email at 0.3** — closes the ops visibility loop
  without waiting for 0.4.
- **Mobile-ready data model** — 1.1+ adds presigned uploads without
  schema change.
- **Redis-backed rate limits** fail closed; Nest throttler is outer
  belt only.
- **Bootstrap SSRF validation** — `S3_ENDPOINT` against IMDS + RFC
  1918 private space + metadata endpoints.
- **Secrets-hygiene integrated** with existing `PRISMA_REDACT_FIELDS`.
- **Prisma-break-glass super-admin paths** are audit-captured
  (snapshot edits, hard-delete).

### Negative

- **API CPU cost** — sharp at 2048 px JPEG 85 ~200-500 ms per photo.
  Profile at pilot; switch to async-worker sanitise if the alert
  fires.
- **Bucket storage** — 0.3 ships retention sweep; default 2 years.
  At pilot (~250 photos/day × 2 MB) = ~360 GB / 2 y / tenant.
  Documented in ops runbook.
- **Schema size** — five tables, two enums, seven CHECK constraints,
  two triggers. Rolled back as ONE migration (see §Rollback).
- **No antivirus at 0.3** — residual-risk §7.
- **Snapshot duplication** — ~1-2 kB/inspection, 64 kB cap.
- **Four-layer isolation discipline** — requires a lint rule + grep
  gate to hold. Tech debt if skipped.
- **`panorama.inspection.photo.viewed` audit volume** — dedup-per-
  minute bounds. At pilot scale (~1 k views/day × < 100 unique/min)
  comfortably absorbed.

### Neutral

- Inspection module is additive; `FEATURE_INSPECTIONS=false` drops it.
- `requireInspectionBeforeCheckout` default false; non-CMV tenants
  unaffected.
- `InspectionTrigger` enum staged for 0.4.
- Per-item translations staged for 0.4.

## Rollback plan

Inline per tech-lead review; full SQL also lands in
`prisma/migrations/20260418xxxxxx_0012_inspections/ROLLBACK.md`.

**Pre-rollback** (preserves audit + evidence):

1. Set `FEATURE_INSPECTIONS=false`, redeploy core-api. Module drops;
   no new inspections / templates / photos written.
2. Super-admin data-export sweep — `pg_dump` tables 1-5 to cold
   storage for the audit team. Per-commitment: inspection rows die
   with the rollback; the `audit_events` chain carrying `panorama.
   inspection.*` survives independently.
3. **S3 stance**: existing `tenants/*/inspections/*` objects are
   RETAINED at rollback. Destroying evidence during a rollback is
   an audit nightmare. Retention sweep + explicit `mc rm --recursive`
   is the post-rollback cleanup path, operator-driven. The rollback
   `ROLLBACK.md` documents the `mc` command for operators who want
   to clean up.

**Rollback SQL** (single transaction):

```sql
BEGIN;

-- Triggers + functions first (before tables they depend on).
DROP TRIGGER IF EXISTS enforce_inspection_snapshot_immutable_trigger
  ON inspections;
DROP TRIGGER IF EXISTS validate_inspection_response_snapshot_ref_trigger
  ON inspection_responses;
DROP FUNCTION IF EXISTS enforce_inspection_snapshot_immutable();
DROP FUNCTION IF EXISTS validate_inspection_response_snapshot_ref();

-- RLS policies (FORCE RLS tables need explicit policy drops).
DROP POLICY IF EXISTS inspection_photos_tenant_isolation        ON inspection_photos;
DROP POLICY IF EXISTS inspection_responses_tenant_isolation     ON inspection_responses;
DROP POLICY IF EXISTS inspections_tenant_isolation              ON inspections;
DROP POLICY IF EXISTS inspection_template_items_tenant_isolation ON inspection_template_items;
DROP POLICY IF EXISTS inspection_templates_tenant_isolation      ON inspection_templates;

-- Tables in reverse-FK order.
DROP TABLE IF EXISTS inspection_photos;
DROP TABLE IF EXISTS inspection_responses;
DROP TABLE IF EXISTS inspections;
DROP TABLE IF EXISTS inspection_template_items;
DROP TABLE IF EXISTS inspection_templates;

-- Enums.
DROP TYPE IF EXISTS inspection_photo_status;
DROP TYPE IF EXISTS inspection_outcome;
DROP TYPE IF EXISTS inspection_status;
DROP TYPE IF EXISTS inspection_item_type;

-- Tenant columns added by this migration.
ALTER TABLE tenants DROP COLUMN IF EXISTS "requireInspectionBeforeCheckout";
ALTER TABLE tenants DROP COLUMN IF EXISTS "inspectionPhotoRetentionDays";
ALTER TABLE tenants DROP COLUMN IF EXISTS "inspectionConfig";

-- Audit redact-list additions do NOT need rollback (extending the
-- list is forward-compatible; leftover entries just redact nothing).

DELETE FROM _prisma_migrations
  WHERE migration_name = '20260418xxxxxx_0012_inspections';

COMMIT;
```

**Prisma client regeneration** — `schema.prisma` edits to drop five
models + all back-relations on `Tenant`, `Category`, `Asset`,
`Reservation`, `User`. Back-relations are on exactly those four
models; grep `inspection` on schema.prisma during rollback to find
them.

**Online-migration hazard** — none on forward migration (empty
tables + new types). Future CHECK tightening (e.g. raising size cap
after rows exist) must use `NOT VALID` + `VALIDATE CONSTRAINT` to
avoid ACCESS EXCLUSIVE table scan. Documented as a future-commitments
note.

**Post-rollback smoke test** — reservation check-out/in still
passes; asset archiving still passes; `audit_events` queries
returning `panorama.inspection.*` rows still work.

## Execution order

1. **This ADR** — v2 → Accepted after review-team re-pass.
2. **Migration 0012** + `rls.sql` + `ROLLBACK.md` — five tables, two
   enums, seven CHECK constraints, two triggers, three Tenant columns.
3. **Audit redactor additions** — `PRISMA_REDACT_FIELDS` extended;
   new `AppLogger` wrapper with unit test for S3-credential-shaped
   error scrubbing.
4. **ObjectStorageModule** — S3 client + key helpers +
   `assertKeyForTenant` + presigned-GET (TTL + headers + response
   overrides) + bootstrap SSRF validation + `.env.example` update
   (add `S3_BUCKET_PHOTOS`, `FEATURE_INSPECTIONS`,
   `S3_ALLOW_PRIVATE_ENDPOINT` dev flag, `S3_SIGNED_URL_TTL_SECONDS`) +
   dev MinIO bucket-init script (`infra/docker/mc-init.sh` +
   compose.dev.yml job). Audit `panorama.boot.object_storage_configured`.
5. **PhotoPipeline** — sharp sanitise (explicit `keepExif/ICC/metadata`,
   `limitInputPixels`, `sequentialRead`) + `file-type` sniff + sha256 +
   `capturedAt` extract + size + count caps. Redis rate limiter
   wiring. Fixture tests with a GPS-tagged JPEG + ICC-tagged PNG +
   decompression-bomb + polyglot PDF-in-JPEG. Assert zero-metadata
   post-sanitise via `exiftool -j` subprocess.
6. **Notification schema + subscriber** — register
   `panorama.inspection.completed` event schema;
   `InspectionOutcomeEmailChannel` for FAIL/NEEDS_MAINTENANCE.
   Template follows invitation-email template pattern.
7. **InspectionService + endpoints** — template CRUD (fleet_admin
   scope), start/respond/complete/review/cancel/resume for inspections,
   photo upload + GET redirect, `latestPassForCheckout` read API.
   Audit hooks everywhere. Mandatory-`runInTenant` lint comment on
   every service method.
8. **Reservation tether wiring** — `ReservationService.checkOut`
   reads `tenants.requireInspectionBeforeCheckout` +
   `tenants.inspectionConfig` + runs the narrow
   `inspections` Prisma query inline (see §8 for full shape); NO
   InspectionService dependency added. Integration test:
   flag on → 409 with no prior inspection; flag on + prior PASS
   within window → success; flag off → pre-existing behaviour
   unchanged; tether flip while vehicles already checked out →
   existing checkouts preserved (only new checkouts gated).
9. **Retention sweep cron** — reuses invitation-maintenance cron hook.
   Batch-500-per-run sweep job. Metric counters named for 0.4 Prom
   exporter.
10. **Integration tests** — cross-tenant photo blocked at all five
    layers (RLS + assertion + key prefix + signed URL + CHECK),
    snapshot preserved after live-template edit, EXIF strip verified
    end-to-end via exiftool fixture diff, template precedence
    (categoryId > categoryKind), scope exclusivity enforced,
    reservation-tether correct on/off, resume-in-progress returns
    same inspectionId, stale auto-cancel cron, retention sweep
    hard-deletes + S3 object gone + audit fires, super-admin
    snapshot edit breaks glass + emits audit, GDPR hard-delete
    path, dedup-per-minute `photo.viewed` audit.
11. **Web UI** — `/inspections` list + filter, `/inspections/new`
    launcher (asset + template; resume-check), `/inspections/:id`
    fill-form with photo uploader + complete action. Admin
    surface for templates. Reservation checkout/checkin page
    "Start inspection" button. Review queue with pending-needs-review
    filter default.
12. **Docs** — `docs/en/inspections.md` ops doc (covers template-
    changes-apply-only-to-new-inspections, 0.3 upload contract
    + stable-wifi assumption, ClamAV-gap release note,
    `requireInspectionBeforeCheckout` flip-on preserves already-
    checked-out vehicles + only gates new checkouts); roadmap.md
    0.3 #4 flipped to complete; feature-matrix.md row updated with
    "per-tenant retention override (Enterprise only)"; i18n
    bundles for every new label (EN / PT-BR / ES) including the
    template-divergence banner ("Template has been edited since
    this inspection started (snapshot preserved)") — persona-
    fleet-ops flagged as a mixed-language-crew requirement.
13. **Canary rollout** — `FEATURE_INSPECTIONS=true` on one pilot
    tenant via env override for 2 weeks before default flips.

**Future-facing commitments** (recorded so 0.4+ contributors don't
re-open this ADR):

- **ClamAV pipeline step** — 0.4. Between sharp sanitise and S3 PUT,
  synchronous scan. `panorama.inspection.photo.infected` audit event.
- **Direct-to-S3 presigned uploads** — 1.1 with mobile. Feature
  flag `FEATURE_INSPECTION_DIRECT_UPLOAD`. Un-confirmed object sweep.
- **Per-tenant retention override UI** — 0.4 Enterprise edition only
  (Community distribution keeps the column + default; the *knob* is
  Enterprise per feature-matrix.md).
- **`InspectionTrigger` enum** — 0.4. `ALTER TYPE inspection_trigger
  ADD VALUE 'CHECKOUT'; ADD VALUE 'CHECKIN';` + wiring to the
  reservation-hook design.
- **Signature + barcode item types** — 0.4+.
- **Plugin-SDK hooks** — 0.4. `onInspectionCompleted` for plugins
  (e.g. auto-open maintenance ticket in Fleetio).
- **Per-item label translation** — 0.4, `translations: Json?` column.
- **Per-channel retry budgets + circuit breaker** — inherits from
  ADR-0011 0.4 commitments.
- **CHECK-constraint-add at scale** — any future `ALTER TABLE
  inspection_* ADD CHECK` post-rows MUST use `NOT VALID` +
  `VALIDATE CONSTRAINT` pattern (data-architect note).
- **`.keepExif(false)`, `keepIccProfile(false)`, `keepMetadata(false)`
  regression guard** — sharp version pin + CI test. A sharp major
  bump must re-prove zero-metadata output before merge.
- **Tenant-admin self-serve photo hard-delete UI** — 0.4. Mirrors
  the super-admin break-glass CLI; scoped to the admin's tenant
  via RLS. Ships so self-hosted tenants acting as their own data
  controllers can action driver DSARs without operator involvement.
- **Pre-checkout hook registry** — 0.4 if tether logic grows richer
  (per-role, vehicle-class, schedule). Would replace the direct
  `ReservationService` → `inspections`-table Prisma read with a
  ChannelRegistry-shaped pattern (matches ADR-0011). Decision
  deferred because 0.3 tether logic is a single boolean + single
  4-hour query; a registry would be over-engineering today.
- **Shared narrow-read util** — if `latestPassForCheckout` shape
  is needed from a second consumer at 0.4+, extract to
  `@panorama/shared` util; do NOT import `InspectionService` from
  a non-inspection module (ADR-0011 boundary preserved).

Each step lands as its own commit, gated by the agent review team.
Step 1 → step 2 is the next commit; subsequent steps gated by
post-commit reviews where relevant.
