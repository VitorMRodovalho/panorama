# ADR-0009: Reservation domain — two-axis state, conflict detection, blackouts, approval

- Status: Proposed
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
- Same `assetId` (and `assetId IS NOT NULL` — basket reservations
  without an asset never conflict with other rows at create time;
  assignment happens at approval / check-out)
- Time ranges overlap, using the standard
  `tstzrange('[startA, endA)') && tstzrange('[startB, endB)')` operator
  — half-open intervals, so back-to-back reservations don't collide.
- The other row's approval_status is one of PENDING_APPROVAL /
  AUTO_APPROVED / APPROVED **and** its lifecycle is not CANCELLED /
  RETURNED / MISSED (i.e. it's still in-play).

This is checked inside the create-reservation transaction, using
`SERIALIZABLE` isolation for the conflict query path so two concurrent
creates for overlapping windows serialise cleanly. A UNIQUE
CONSTRAINT on a generated tstzrange exclusion would be stronger but
Postgres requires btree_gist + a GIST index; we ship the service-level
check for 0.2 and revisit the exclusion constraint in 0.3 if we see
real contention.

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

## Out of scope for 0.2 step 4 Part A

Part A ships everything above EXCEPT:

- **Check-out / check-in** with captured mileage, condition,
  photos, damage reports. Lands in Part B.
- **Basket reservations** (one reservation holding multiple assets of
  different models). The schema allows `assetId=null` today; Part B
  adds `reservation_items` for the multi-asset bag + the assignment
  flow at approval / checkout.
- **Calendar view** on web. Part A ships a list + form only; the
  calendar / timeline UI lands with Part B.
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
