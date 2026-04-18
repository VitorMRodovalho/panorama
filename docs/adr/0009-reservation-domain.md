# ADR-0009: Reservation domain — two-axis state, conflict detection, blackouts, approval

- Status: Accepted (implemented in 0.2 step 4 Parts A + B, 2026-04-18)
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md), [ADR-0007 Tenant Owner](./0007-tenant-owner-role.md), [ADR-0008 Invitation flow](./0008-invitation-flow.md)

## Context

Panorama inherits SnipeScheduler-FleetManager's operational fleet /
asset reservation flow. The schema already has a `Reservation` model
from 0.1 (ADR-0003), but 0.2 step 4 is the first commit that turns
those columns into a real domain: admins can approve / reject,
drivers can book vehicles, the system blocks overlapping bookings,
and ops can carve out blackout windows (maintenance, holidays).

The recurring failure modes we're defending against:

- **Double-booking**: two drivers both book asset X from 14:00 to
  16:00. Database-level guarantee, not a best-effort service check.
- **Ghost reservations**: approved reservation for a vehicle that
  has since been sent to maintenance.
- **Overloaded drivers**: one requester silently booking 50 vehicles
  "just in case". Per-user concurrency cap.
- **No-notice bookings**: someone books an asset for "right now"
  when ops policy wants a 24 h heads-up.
- **Runaway long holds**: week-long bookings blocking the fleet.
- **Orphaned approvals**: admin approves before the requester fills
  in purpose. Fleet-manager had this; we avoid it by requiring purpose
  at create.

FleetManager's prior art (see `src/reservation_validator.php`,
`public/approval.php`, `public/blackouts.php`):

- Two independent state axes — `approval_status` (pending_approval /
  auto_approved / approved / rejected) and lifecycle `status`
  (pending / confirmed / checked_out / returned / cancelled / missed /
  maintenance_required / redirected).
- Conflict detection via SQL overlap on `(asset_id, start, end)`.
- `blackout_slots` table with optional `asset_id` (NULL = global).
- Reservation controls (min-notice, max-duration, max-concurrent) as
  platform-wide config + a "staff bypass" boolean.
- `approval_history` separate table with action + actor + notes.

## Decision

Port the FleetManager shape to Panorama, adapted for multi-tenant
Postgres + the typed NestJS service layer. Four building blocks:

### 1. Two-axis reservation state

Keep the existing enums:

- `ApprovalStatus`: `PENDING_APPROVAL` | `AUTO_APPROVED` | `APPROVED` | `REJECTED`.
- `ReservationStatus` (lifecycle): `BOOKED` | `CHECKED_OUT` | `RETURNED`
  | `CANCELLED` | `MISSED` | `MAINTENANCE_REQUIRED` | `REDIRECTED`.

Rationale for splitting: approval is an administrative decision
(did ops accept this booking?); lifecycle is a physical-world state
(is the asset currently out?). Collapsing them loses expressiveness
when a future workflow extension needs one without the other.

### 2. Conflict detection

A reservation is in conflict with another when **all of**:

- Same `tenantId`
- Same `assetId` (rows with `assetId IS NULL` are not currently
  supported at create time — the DTO (`CreateReservationSchema`,
  `CreateBasketSchema`) requires a concrete assetId. An assetless-
  basket workflow (model pool → asset allocated at approval / check-
  out, FleetManager-style) is a deliberate non-goal for 0.2 — see
  §"Basket multi-asset" below for the rejected option A.
- Time ranges overlap, using the standard
  `tstzrange('[startA, endA)') && tstzrange('[startB, endB)')` operator
  — half-open intervals, so back-to-back reservations don't collide.
- The other row's approval_status is one of PENDING_APPROVAL /
  AUTO_APPROVED / APPROVED **and** its lifecycle is not CANCELLED /
  RETURNED / MISSED (i.e. it's still in-play).

This is checked inside the create-reservation transaction at Postgres
`Serializable` isolation (via `runAsSuperAdmin(cb, { isolationLevel:
'Serializable' })`). Two concurrent creates that both pass the
`assertNoOverlap` probe and then both try to INSERT will surface
SQLSTATE 40001 / Prisma `P2034`; `PrismaService.runTxWithRetry` retries
up to 3 times with short jittered backoff. On the retry the losing
transaction sees the committed row and returns 409 `reservation_conflict`.
The approve path runs at the same isolation so an admin-approved row
that conflicts with a freshly-created pending row yields the same
retry-then-409 path.

A `btree_gist` + GENERATED tstzrange exclusion constraint would move
the guarantee to the DB layer without the retry loop and is tracked
for 0.3; Serializable + retry is sufficient at 0.2 scale and has a
race test
(`apps/core-api/test/reservation-basket.e2e.test.ts::"concurrent
baskets..."`) that proves the invariant holds.

### 3. Blackouts

New table `blackout_slots`:

- `id`, `tenantId` (tenant-scoped), `title`, `startAt`, `endAt`
- Optional `assetId` — NULL means "all assets in this tenant"
- `reason` (free text), `createdByUserId`, timestamps
- Indexed by `(tenantId, startAt)` + `(tenantId, assetId)`
- Enforced in reservation-create: if the requested range overlaps any
  blackout matching the asset (or a global one), refuse.
- Blackouts are admin-only CRUD (owner / fleet_admin).

### 4. Reservation controls (per-tenant config)

`Tenant.reservationRules` JSON, with shape:

```json
{
  "min_notice_hours": 0,
  "max_duration_hours": 0,
  "max_concurrent_per_user": 0,
  "auto_approve_roles": ["owner", "fleet_admin", "fleet_staff"]
}
```

`0` means "unlimited / not enforced". Per-tenant customisation without
a schema migration. Enterprise can add a UI for editing; Community
operators edit via the super-admin CLI or SQL.

**Auto-approve rule**: if the requester's role is in
`auto_approve_roles`, or their membership is `isVip=true`, the
reservation lands with `approvalStatus=AUTO_APPROVED`. Otherwise
`PENDING_APPROVAL`.

**Staff-bypass**: the legacy FleetManager "staff_bypass" flag is
modelled by including staff roles in `auto_approve_roles`. Tenants
that want stricter gating drop roles from the list.

### 5. Permissions

- **Create** — any active member of the tenant.
- **Create on behalf of** — requires `onBehalfUserId` to be a member of
  the same tenant; allowed for roles in `auto_approve_roles` (staff /
  admin / owner) + VIP users.
- **List own + admin list all** — members see their own reservations
  (requester or onBehalf); admins (`owner`, `fleet_admin`) see the
  tenant-wide list.
- **Cancel** — requester or any admin. A cancelled reservation keeps
  the row (soft transition — lifecycle=CANCELLED + `cancelledAt`),
  for audit continuity.
- **Approve / Reject** — `owner` or `fleet_admin` only.

### 6. Audit

Every state change emits `panorama.reservation.<verb>`:

- `created` / `auto_approved` / `approved` / `rejected` /
  `cancelled` / `checked_out` / `checked_in` / `missed` / `redirected`

Metadata includes `{ assetId, requesterUserId, onBehalfUserId,
startAt, endAt, reason?, approverUserId? }` so auditors can
reconstruct the state sequence without joining against live rows.

## Part B additions (shipped 2026-04-18)

### Check-out / check-in data capture

Migration 0007 adds nullable capture columns on `reservations`:
`checkedOutAt`, `checkedOutByUserId`, `mileageOut`, `conditionOut`,
`checkedInAt`, `checkedInByUserId`, `mileageIn`, `conditionIn`,
`damageFlag BOOLEAN DEFAULT false`, `damageNote TEXT`. Service
invariants:

- Check-out requires approval_status in {APPROVED, AUTO_APPROVED}
  and lifecycle=BOOKED. Asset must be READY or RESERVED (not
  MAINTENANCE/RETIRED). On success: lifecycle→CHECKED_OUT and
  `asset.status → IN_USE`.
- Check-in requires lifecycle=CHECKED_OUT. Mileage monotonicity
  enforced (in ≥ out when both present). `damageFlag=true` routes
  `asset.status → MAINTENANCE` on check-in (ops inspects before
  the asset becomes bookable again); otherwise READY.
- Authorization: requester, onBehalf target, the user who
  performed the check-out, or admin.

### Basket multi-asset — option B: shared `basketId`

Migration 0008 adds `reservations.basketId UUID NULL` + index on
`(tenantId, basketId)`. The creation endpoint
`POST /reservations/basket` takes
`{ assetIds: [...], startAt, endAt, purpose }` and in one transaction
creates N reservations with the same generated `basketId`. Each row
then behaves independently at the lifecycle level — check-out and
check-in are per-reservation (different drivers may pick up different
trucks from the same basket at different times); approve / reject /
cancel can be invoked per row **or** batched on the whole basket (see
§"Basket batch decisions" below). The basket is primarily a creation-
time + UX grouping (shared colour / pill in the list and calendar).

Rejected alternative (option A): a `reservation_items
(reservation_id, model_id, quantity)` line-item table with assets
allocated at check-out from the model pool — FleetManager's pattern,
better for rental-equipment-style workflows ("2 cameras of model
X"). For fleet-asset workflows the user typically wants a specific
vehicle, and option B keeps the schema thin + each row's lifecycle
self-contained. Option A remains an easy addition later if
model-pool allocation turns into a concrete requirement.

### Basket batch decisions

Approving a 5-truck basket one row at a time was a 15-click operation
versus 3 clicks in the SnipeScheduler-FleetManager tool we're
replacing. The 2026-04-18 fleet-ops persona review surfaced this as
an adoption blocker. Batch endpoints close the gap without changing
the underlying per-row state model:

- `POST /reservations/basket/:basketId/approve`  (owner / fleet_admin)
- `POST /reservations/basket/:basketId/reject`   (owner / fleet_admin)
- `POST /reservations/basket/:basketId/cancel`   (admin OR non-admin
  who is requester/onBehalf on **every** row of the basket — see
  "Authorization" below)

**Semantics — best-effort with per-row skip.** The batch runs inside
a single Serializable transaction with the existing P2034 retry
wrapper. For each row of the basket the service:

1. Checks the lifecycle + approval predicate (PENDING_APPROVAL for
   approve/reject; not CANCELLED/RETURNED/CHECKED_OUT for cancel).
   Failing rows are recorded as `skipped` with a machine-readable
   reason ("already_cancelled", "not_pending:rejected", etc.).
2. Runs the per-row transition via the shared `decideWithin(tx, ...)`
   or `cancelWithin(tx, ...)` internal — the same code paths the
   single-row endpoints use, so conflict re-check + blackout re-check
   + audit event emission stay identical. A fresh overlap conflict
   on approve is a per-row skip (reason
   `reservation_conflict`), not a batch abort; the ops user sees
   "3 of 5 approved, 2 skipped (reservation_conflict)" and can take
   targeted action on the remaining rows.
3. A non-skippable exception (DB error, permission error) propagates
   and rolls back the whole batch — the envelope audit event below
   rolls back with it, so no lying summary row is ever committed.

**Authorization.** Approve / reject are admin-only (matching the
per-row endpoints). Cancel requires **either** admin **or** that the
actor is requester/onBehalf on every row of the basket. Partial
ownership is rejected with 403, not silently filtered — returning a
mixed skip-list to a non-admin would leak which other rows exist in
the basket. In practice baskets are single-requester by construction
(`createBasket` copies the actor's id into every row), so this rule
is transparent for legitimate users.

**Error-code disclosure — deliberate.** A basketId belonging to
another tenant returns 404 `basket_not_found` (cross-tenant rows
filter out at query time); a basketId belonging to the caller's
tenant but owned by a peer returns 403 `not_allowed_to_cancel`. A
same-tenant peer can therefore distinguish "exists but not mine"
from "doesn't exist in this tenant". This is consistent with the
per-row cancel endpoint and is an accepted disclosure — tenant
membership is not itself confidential between members.

**Audit.** Per-row events remain (`panorama.reservation.approved` /
`rejected` / `cancelled`) — existing audit queries by
`resourceType=reservation` keep working unchanged. A new envelope
event per batch (`panorama.reservation.basket_approved` /
`basket_rejected` / `basket_cancelled`) carries the full
`{ basketId, processedCount, skippedCount, processedReservationIds,
skipped: [{reservationId, reason}], note?, reason? }`. An on-call
paged at 3am runs one query on the envelope events to reconstruct
"who approved which basket, what was skipped, why".

**Result shape.** The service returns:

```json
{
  "basketId": "…",
  "processed": [{ "reservationId": "…", "outcome": "approved" }, …],
  "skipped":   [{ "reservationId": "…", "reason": "reservation_conflict" }, …]
}
```

Processed + skipped never overlap and together cover every row of
the basket.

**Size cap.** `CreateBasketSchema` caps `assetIds.length` at 20; the
batch endpoints inherit that ceiling via the rows that exist. A
Serializable retry on a 20-row batch replays the loop; at 3 attempts
× 20 rows the worst case is 60 iterations plus audit writes, which
fits comfortably in the transaction window.

**Feature flag.** `reservationRules.enable_basket_batch` (default
`true`) toggles the batch endpoints per tenant. Set to `false` via
SQL to disable server-side without a redeploy — a defensive valve if
a tenant hits pathological contention.

**Rollback.** The three endpoints + `runBasketBatch` + the new
`decideWithin` / `cancelWithin` extractions are code-only (no
migration, no new column — the `basketId` column already exists
since migration 0008). A revert of the commit removes the endpoints;
the per-row endpoints remain functional throughout.

### Calendar view

`/reservations/calendar` renders a 14-day (toggle 7/14/30) timeline:
per-asset rows, colored blocks per state, asset-scoped blackouts as
amber blocks, global blackouts as a thin amber bar across every
asset's track. Server-rendered only — zero client JS for 0.2.

## Out of scope (deferred)
- **Snipe-IT asset-status propagation** — FleetManager flipped the
  Snipe-IT `status_label` on approval / check-out. Panorama owns both
  sides in 0.2 so propagation isn't needed; integration with an
  external Snipe-IT for customers still on that system lands with
  the compat shim in step 5.
- **Inspection checklist + photos**. Deferred to 0.3.
- **Email notifications on approval / reminder / expiring**. Deferred
  to 0.3 / 0.4 (notification event bus).

## Alternatives considered

### Collapsed single-axis state machine

Tempting but loses fidelity. Approval is an admin concern; lifecycle
is a physical one. Keeping them independent matches how operators
actually think about a booking.

### Exclusion constraint via `btree_gist` + tstzrange

Stronger double-booking defence (DB-level guarantee instead of
service-level SERIALIZABLE transaction). Deferred to 0.3 because:
- Requires the `btree_gist` extension (easy enough)
- Requires a migration that adds a GENERATED column for the tstzrange
  plus the exclusion constraint — more schema surface
- Service-level check is good enough at 0.2 concurrency, and letting
  it bake surfaces the UX for "your reservation conflicts with X"
  that an exclusion constraint hides behind a raw error code.

Revisit when we see real contention in production.

### Blackouts as a Reservation with status=MAINTENANCE_REQUIRED

Modelling blackouts as "synthetic reservations" would let the same
conflict code cover both. Rejected because:
- Blackouts have no requester; shoving a fake requester into the
  column muddies the audit story.
- Blackouts can be global (asset_id NULL); Reservation requires an
  asset on the conflict path.
- Two separate tables keep the schema honest about what each row
  means.

### Per-asset `autoApprove` flag

Simpler than `auto_approve_roles` per-tenant. Rejected because
auto-approval is a policy about *who*, not *what* — the same asset
might auto-approve for staff and gate for drivers. Tenant-scoped
role list covers both shapes.

## Consequences

### Positive

- Port of a production-tested FleetManager pattern without importing
  its PHP globals / per-table conventions.
- Two-axis state machine is flexible enough for the 0.3 additions
  (inspection, maintenance) without re-opening the design.
- Audit events on every transition give ops the same visibility as
  FleetManager's approval_history without a dedicated table.

### Negative

- Service-level conflict detection means the integration tests have
  to cover the race (concurrent creates). Worth the coverage.
- Reservation rules in JSON means there's no enum-level validation
  on the role list — typos in `auto_approve_roles` fall through. A
  light Zod validator in the service layer catches the common cases.

### Neutral

- Enterprise tier can extend this with SLA-driven approval queues,
  automated re-allocation, and timezone-aware blackouts without
  reopening the ADR.

## Execution order

1. **0.2 step 4 Part A (this commit stream)** — migration +
   ReservationService (create / list / cancel + validation +
   blackouts) + approve/reject + blackout CRUD + minimal web UI +
   integration tests.
2. **0.2 step 4 Part B** — check-out / check-in (mileage, condition,
   damage); basket reservations; calendar view.
3. **0.3** — inspection checklists; photos + EXIF strip;
   notification event bus hooks (reservation-approved email, etc.);
   exclusion-constraint migration if contention shows up.
4. **0.4** — SLA-based approval routing, automated re-allocation on
   asset maintenance.

This ADR is the contract for Part A. Any design change (e.g.
switching to an exclusion constraint earlier than 0.3) lands as an
ADR update first, code second.
