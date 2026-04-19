# Inspections

Configurable pre-trip / post-trip checklists with photo evidence and EXIF
strip — Panorama 0.3 (ADR-0012). This page is the operator reference for
the feature: how it behaves, the contracts the API exposes, and the
release-note caveats pilots need to know about before a flag flip.

> Status: backend feature-complete (steps 5–10 of ADR-0012 §Execution
> order). Web UI ships in step 11. The feature stays dark behind
> `FEATURE_INSPECTIONS=false` until a canary tenant validates it.

## Contents

1. [Concepts](#concepts)
2. [Lifecycle](#lifecycle)
3. [Templates: edits apply only to **new** inspections](#templates-edits-apply-only-to-new-inspections)
4. [Photo upload contract (0.3)](#photo-upload-contract-03)
5. [Reservation tether: flip-on safety](#reservation-tether-flip-on-safety)
6. [Retention + GDPR](#retention--gdpr)
7. [Release-note caveats](#release-note-caveats)

---

## Concepts

| Term | Meaning |
|------|---------|
| **Inspection template** | The admin-authored checklist for a category of asset (or a specific category). Lives in `inspection_templates` + `inspection_template_items`. |
| **Inspection** | One driver-or-admin run-through of a template against a specific asset. Carries a frozen **snapshot** of the template at start time. |
| **Snapshot** | The immutable copy of the template stored on `Inspection.templateSnapshot`. Per ADR §2 a BEFORE-UPDATE trigger refuses any write to this column without the `panorama.allow_snapshot_edit` GUC (super-admin break-glass). |
| **Outcome** | `PASS`, `FAIL`, or `NEEDS_MAINTENANCE`. Set on `complete`. Triggers the FAIL-outcome email per ADR §11. |

## Lifecycle

```
            start                       complete                    review
           ────────►   IN_PROGRESS  ────────────►   COMPLETED  ────────────►
                            │                          │
                            │ cancel                   │ (only FAIL /
                            ▼                          │  NEEDS_MAINTENANCE
                         CANCELLED                     │  open the queue)
                                                       ▼
                                              Closed: reviewedAt + reviewNote
```

- `start` resolves the template (categoryId beats categoryKind, ADR §1)
  and writes the snapshot. If the same driver already has an
  IN_PROGRESS inspection on this asset within
  `inspectionConfig.staleInProgressHours` (default 24 h), `start`
  **resumes** the existing row instead of creating a new one — the
  response carries `resumed: true`.
- `respond` writes `InspectionResponse` rows; idempotent on
  `(inspectionId, snapshotItemId)`.
- `complete` requires every required item to have a response (and
  every photoRequired item to have at least one photo). Emits
  `panorama.inspection.completed` on the notification bus —
  `InspectionOutcomeEmailChannel` (ADR §11) routes FAIL /
  NEEDS_MAINTENANCE to active `owner | fleet_admin` memberships.
- `review` is admin-only. The conditional update on `reviewedAt IS NULL`
  defeats the two-admins-clicking-Close race; loser gets 409.
  `reviewNote` is appendable post-review for body-shop follow-up — every
  edit emits `panorama.inspection.review_note_updated`.
- `cancel` from IN_PROGRESS works (idempotent re-cancel returns 200);
  cancel-after-complete returns 409. Photos attached to a CANCELLED
  inspection persist — the retention sweep decides when they go.

The maintenance cron (daily) auto-cancels IN_PROGRESS rows older than
`3 × staleInProgressHours` (default 72 h); audit
`panorama.inspection.auto_cancelled reason='auto_cancel_stale'`.

## Templates: edits apply only to **new** inspections

This is the load-bearing operator promise. When an admin PATCHes a
template — even replacing the whole `items` array — every existing
IN_PROGRESS / COMPLETED inspection keeps the original snapshot. The
review form notices the divergence and surfaces a banner:

> *Template has been edited since this inspection started (snapshot preserved).*

— per persona-fleet-ops, mixed-language crews need this in their
locale; the string is in `packages/i18n/{en,pt-br,es}/common.json`
under `inspection.template.divergence_banner`.

What this means in practice:

- Adding an item to a template does **not** retroactively make older
  inspections "incomplete". Their snapshot didn't have that item, so
  there's nothing to answer.
- Removing an item from the live template does **not** orphan responses
  on older inspections. The snapshot still has the item; the response
  still anchors against it.
- Renaming an item changes the live label only. Older snapshots show
  the old label as the driver / reviewer saw it at the time.

Snapshot integrity is enforced four ways (ADR §2): a service-layer Zod
parse at start time, two CHECK constraints
(`inspections_snapshot_well_formed` rejects empty `items[]`,
`inspections_snapshot_size_cap` rejects > 64 kB), and a BEFORE-UPDATE
trigger refusing column changes without the break-glass GUC.

## Photo upload contract (0.3)

```
POST /inspections/:id/photos
Content-Type: multipart/form-data

  photo            (file, ≤ 10 MB)
  clientUploadKey  (uuid)
  responseId       (uuid, optional)
```

**Server pipeline** (per ADR §4):

1. Multer cap (10 MB) → 413 `photo_too_large`.
2. Per-tenant + per-user Redis rate limiter (20 / hour user; 200 / hour
   tenant). Fails closed on Redis outage. Hits return 429 with
   `retryAfterSeconds`.
3. Per-inspection cap (default 20, `inspectionConfig.maxPhotosPerInspection`).
4. Magic-byte sniff (`file-type`). Accept JPEG / PNG / WebP / HEIC /
   HEIF; everything else 415 `unsupported_media_type`.
5. `sharp.metadata()` pre-flight pixel cap (24 M default,
   `PHOTO_LIMIT_INPUT_PIXELS`). Decompression bombs fail 400
   `photo_too_large_pixels`.
6. `exifr` extracts `DateTimeOriginal` (best-effort; null on parse
   failure). Bounded to first 64 KB of input.
7. Sharp re-encode: rotate(EXIF) → resize(longest 2048, no enlarge) →
   JPEG q85. Default behaviour since sharp 0.33 strips EXIF / ICC /
   XMP / IPTC; the load-bearing CI guard is the exiftool round-trip
   in `apps/core-api/test/photo-pipeline.test.ts` (skips on dev boxes
   without exiftool installed; CI image is expected to have
   `libimage-exiftool-perl`).
8. SHA-256 over the sanitised buffer.
9. S3 PUT (server-minted UUID becomes both row PK and storage key
   path component).
10. DB row + audit (`panorama.inspection.photo.uploaded` with
    `exifStripped` field NAMES — values never logged).

**Idempotency**: a retry with the same `clientUploadKey` + same
`inspectionId` returns the already-written row (`deduped: true`). A
collision where the existing row's `uploadedByUserId` ≠ the retrying
user audits `panorama.inspection.photo.rejected reason='upload_key_collision'`
and returns 409 — closes the existence-oracle that v2 of the ADR had.

**Stable wifi assumption (0.3)**: the upload is web-only and assumes
the driver is in range when they fill the form. Tab close mid-fill
loses queued local state. Mobile-first offline + direct-to-S3
presigned uploads land in 1.1 (ADR §Future-facing commitments).

**ClamAV gap (0.3)**: 0.3 does NOT scan uploaded bytes for malware.
The compensating controls per ADR §7 are sharp's re-encode (defeats
polyglots), the magic-byte sniff (defeats extension lies), and the
`Content-Disposition: attachment` + `Content-Type: image/jpeg`
response overrides on the signed-URL view path (a browser can't
interpret slipped-through bytes as HTML). 0.4 plugs in a synchronous
ClamAV scan between sanitise and S3 PUT — `panorama.inspection.photo.infected`
audit event.

**Browser reads** go through `GET /inspections/:id/photos/:photoId`
which 302-redirects to a presigned S3 URL with TTL 60 s (list
thumbnails) or 300 s (detail view). Response carries
`Cache-Control: private, no-store` + `Referrer-Policy: no-referrer`.
The `panorama.inspection.photo.viewed` audit deduplicates per minute
on `(userId, photoId, viewKind)` via Redis SETNX so a list scroll
across 50 photos doesn't flood the audit chain.

## Reservation tether: flip-on safety

`Tenant.requireInspectionBeforeCheckout` (boolean, default false).
When ON, `ReservationService.checkOut` requires a COMPLETED + PASS
inspection by the checkout actor on the asset within
`inspectionConfig.preCheckoutInspectionMaxAgeMinutes` (default 240 min).
No prior PASS in window → 409 `inspection_required` + audit
`panorama.reservation.checkout_blocked`.

**Flip-on safety** (operator promise): the gate runs ONLY in the
`BOOKED → CHECKED_OUT` transition. Vehicles already CHECKED_OUT
before the flag flipped continue through `checkIn` unchanged. Test
coverage in `test/reservation-inspection-tether.e2e.test.ts` pins
this — flipping the flag while a vehicle is in someone's hands does
NOT strand them.

The success-path audit row (`panorama.reservation.checked_out`)
gains a `preCheckoutInspectionId` field whenever the tether fired,
so insurance / audit reviews can trace "which inspection authorised
this checkout".

## Retention + GDPR

**Soft-delete + retention sweep**: setting `InspectionPhoto.deletedAt`
schedules the photo for hard-deletion. The daily sweep
(`InspectionMaintenanceService.runPhotoRetentionSweep`) hard-deletes
photos whose `deletedAt` exceeds the per-tenant retention.

| Knob | Default | Floor |
|------|---------|-------|
| `Tenant.inspectionPhotoRetentionDays` | 425 d (DOT 49 CFR §396.3 14-month + 2-month buffer) | 30 d (DB CHECK) |

The sweep deletes the S3 object first, then the DB row, then writes
`panorama.inspection.photo.hard_deleted reason='retention_sweep'`. S3
or DB failures skip the row and retry on the next sweep — partial
failures don't abort the batch.

**GDPR Art. 17 right-to-erasure** (DSAR SLA: 30 days from intake).
0.3 ships the super-admin break-glass mechanism (set the
`panorama.allow_snapshot_edit` GUC, audit-of-intent BEFORE write,
delete S3 + row hard-delete). 0.4 ships the tenant-admin self-serve
UI per ADR §9 — for now, operator escalation actions a CLI.

## Release-note caveats

These are the things to surface in pilot onboarding so an operator
isn't surprised:

- **Tab-close loses queued local state** (0.3 web-only). Mobile-first
  offline lands at 1.1.
- **No malware scanning** (0.3). sharp re-encode + sniff + signed-URL
  hardening are the compensating controls; ClamAV ships at 0.4.
- **Per-tenant retention override is Enterprise-only at the UI layer.**
  Community ships the column + sweep + 30-day floor; only Enterprise
  exposes the per-tenant config UI to tenant admins.
- **Template edits never retroactively change old inspections.** This
  is a feature, not a bug — surface the divergence banner string
  prominently in onboarding so reviewers know to look for it.
- **`requireInspectionBeforeCheckout` flip-on does not strand active
  checkouts.** Already-CHECKED_OUT vehicles complete checkIn without
  needing an inspection.
- **DSAR turn-around is operator-actioned in 0.3** (super-admin CLI,
  30-day SLA). 0.4 ships the tenant-admin UI.
