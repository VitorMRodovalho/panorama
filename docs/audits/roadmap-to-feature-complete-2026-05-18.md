# Roadmap to feature-complete fleet management platform

> **Status — Maintainer-approved with decisions 1-4 logged (2026-05-18).**
> Synthesis of a 5-agent strategic planning round (product-lead +
> data-architect + tech-lead + ux-critic + persona-fleet-ops).
> Maintainer signed off on the wave sequence + made four blocking
> decisions; see §"Decision points — RESOLVED" below. The per-wave
> PRs land their own ADRs as they ship.

## Executive summary

The maintainer's directive (2026-05-18): drive Panorama to be
**the best asset and fleet management platform for projects and
corporate environments**, with control, scheduling, asset/car
assigned to user or team, maintenance control, and all other
resources for the best management. Customer-first; persona click
journeys simulated; agent committee invoked where required;
partial commits.

The 5-agent committee converged on a structured wave plan covering
**~12 waves from current state (Wave 0 mid-flight) through public
launch + Enterprise readiness**. Single highest-leverage wave:
**Driver Mobile PWA + photo-evidence GA** (named by
persona-fleet-ops as "the one wave that flips a paying customer").
Hardest prereq: **`ADR-0021 web frontend architecture`** must land
before any feature wave to settle features-folder layout, RSC vs
client-fetch strategy, and mobile route group separation.

## Working agreement

Per the maintainer's directive, the execution discipline is:

- **Partial commits where needed.** Each wave is multi-PR; PRs ship
  one capability at a time with the 5-agent per-PR scan cadence
  established in Wave 0 / Round 5+6.
- **Agent committee invoked where required.** Five agents named by
  role (tech-lead, data-architect, security-reviewer, product-lead,
  persona-fleet-ops) + ux-critic for any apps/web/ surface change.
  Each PR gets a scan; each wave gets a planning scan + a close-out
  scan.
- **Customer-first always.** Every wave delivers a **persona
  walkthrough doc** alongside the code: 4-persona click journeys
  (Fleet manager, Dispatcher, Driver, Maintenance tech) simulated
  end-to-end. A wave is not done until the walkthrough demonstrates
  the persona can complete the named workflow.
- **Data architecture quality.** data-architect veto power on every
  schema-touching PR. Effective-dated, append-only, RLS-FORCEd by
  default. No JSONB on operational state. No `INHERITS`
  partitioning.
- **UX/UI for the user.** ux-critic gates every apps/web/ change.
  No modal-stacking, no AI-hero strips, no infinite scroll on
  operational tables. Design-system primitives before per-page
  custom CSS.

## Current state (2026-05-18)

- **Backend:** 28 migrations applied through 0026 (PR3 / Round 6).
  Multi-tenant Postgres on Supabase managed (staging) + dev-stack
  docker (local). RLS strong (`panorama_app` NOBYPASSRLS;
  cross-tenant only via `panorama_super_admin` SECURITY DEFINER
  bypass). Audit chain hash-chained tamper-evident (migrations
  0021/0026). Reservation engine with DB-enforced exclusion
  constraint (no double-booking possible by construction).
  Maintenance, inspection, notification, signup, tenant-export
  modules all production-shaped.
- **Frontend:** Next.js 16 + React 19. **Five components total**
  in `apps/web/src/components/`. Single flat `lib/api.ts`. No
  features-folder layout. ~10% of FleetManager v2.1 / Snipe-IT
  feature surface per session-end perception walkthrough.
- **Wave 0:** ~9/10 closed. Pending: Round 6 PR2b (executed restore
  drill against staging with observed RTO/RPO) + Round 7
  (Privacy/ToS/SBOM/v2 6-agent scan/URL-flip ADR-0014 amendment).
- **Documentation:** incident.md (442 lines), secrets-rotation.md
  (1193 lines post-PR3), restore.md (481 lines post-PR2a),
  verify-audit-chain.md, secrets-inventory.md. Comprehensive
  operator-side surface.
- **CI:** 14 gates green (lint, typecheck, unit tests, web unit
  tests, i18n coverage, no-enterprise-imports, dependency licence
  scan, Trivy SCA, gitleaks, CodeQL, community-smoke e2e, etc.).
- **Pre-revenue, Community-only.** Enterprise positioning is
  forward-looking in feature-matrix.md.

### Critical findings from the planning round

1. **`Asset.assignedUserId` is a fossil column** (schema.prisma:528,
   migration 0001:142). Defined since the first migration but never
   read by any application code. Verified via `grep -rn assignedUserId
   apps/` returning zero hits. **Trap:** the first PR implementing
   asset assignment will pollute this column without realising it has
   no FK / no index / no RLS. Drop in migration 0028 (per
   data-architect veto §9).
2. **`/` redirects unconditionally to `/assets`** (apps/web/src/app/page.tsx).
   Wrong for every persona except a one-time configurator. Replace
   with role-aware dashboard in Wave 0+.
3. **No `/me` route exists.** FleetManager v2.1 has `my_bookings.php`;
   drivers can't self-serve their bookings on Panorama today. Named
   by persona-fleet-ops as a load-bearing gap.
4. **No web feature-folder architecture.** Tech-lead requires
   `ADR-0021` to settle features/, RSC/data-fetching, mobile route
   group, state management before any feature wave.

## Vision / target state

Panorama becomes **the AGPL multi-tenant operations primitive for
mixed corporate fleets** (per product-lead synthesis). The bet:
corporates running mixed assets (vehicles + IT + tooling) want
**Snipe-IT's openness with FleetManager's reservation discipline**,
plus a procurement-credible audit story neither competitor leads
with. Not "the open FleetManager" (their dispatch board is
purpose-built for rail), not "Snipe-IT plus a calendar" (asset-only
DNA), but **the booking-and-accountability platform** for
organisations that need to prove who had which asset when.

Three load-bearing differentiators:

1. **Tamper-evident audit chain.** SHA256 hash-chained with
   byte-exact pre-image persistence (migrations 0021+). Sales
   asset: `audit-chain-integrity.e2e.test.ts` + `restore-drill.sh`.
   Regulatory ammunition FleetManager + Snipe-IT cannot match.
2. **DB-enforced reservation invariants.** Exclusion constraint
   on the partial in-play set (migration 0010). Double-booking is
   impossible regardless of service-layer correctness. Wave
   extensions (recurring, soft holds) inherit the invariant.
3. **Driver-mobile PWA with photo evidence.** Wave B's flag in
   the ground. PWA on a 5-year-old Android in a bus barn (no
   signal). Persona-fleet-ops: "this alone moves me to buying."

## Wave structure

**Sequencing decision:** close Wave 0 first (no parallel feature
work) per product-lead's strategic recommendation. Universal
agreement across the 5 agents. Hosted-URL flip is the
customer-discovery instrument; Wave A scope finalises only after
the first 3 design-partner conversations land.

| Wave | Scope | Persona | Edition | Migration risk | PRs |
|---|---|---|---|---|---|
| **0 closure** | Round 6 PR2b (executed drill) + Round 7 (Privacy/ToS/SBOM/URL-flip) | — | Community | None | 5-7 |
| **0+** | ADR-0021 web architecture + features/ scaffold + role-aware `/` + `Button`/`Card`/`EmptyState` primitives + light theme + tap-target audit | All (foundation) | Community | None | 3-5 |
| **A — Foundations** | Migration 0027 (Teams) + 0028 (AssetAssignment effective-dated; drop fossil `assignedUserId`) + RLS extension | All (especially Fleet manager, Dispatcher) | Community | Medium (multi-phase NOT NULL discipline) | 4-6 |
| **B — Driver Mobile PWA + photo-evidence GA** | `/me` driver landing + QR deep-link `/r/:id` + mobile route group `(driver)/` + `FEATURE_INSPECTIONS` default-on (close 0.3 #4 canary) | Driver | Community | Low | 5-8 |
| **C — Dispatcher Power Tools** | Calendar drag-to-reschedule + bulk approve with optimistic-lock + "affected reservations from maintenance ticket" + 1-click reassign | Dispatcher | Community | Low | 4-6 |
| **D — Fleet Manager Dashboard + Reports v1** | KPI dashboard tiles + 5 canned reports (utilisation, mileage, maintenance cost, missed reservations, damage incidents) + async export via existing TenantExport | Fleet manager | Community (CSV exports + saved reports); Enterprise (scheduled delivery + XLSX/PDF) | Low | 4-6 |
| **E — Maintenance Power Tools** | Migration 0030 (per-asset PM schedules; hour-meter for non-vehicle assets) + `/maintenance/queue` + parts/labour line items + photo evidence | Maintenance tech | Community | Low-Medium | 4-6 |
| **F — Reservation Engine v2** | Migration 0029a/b/c (ReservationSeries + soft holds + enum extension via standalone migration + CONCURRENTLY exclusion rebuild) + recurring bookings UI | Dispatcher | Community | High (enum hazard + exclusion rebuild) | 3-5 |
| **G — Reporting v2 + Read-Models** | Migration 0031 (asset_utilisation_daily + tenant_kpi_daily rollups) + per-module reporting views + scheduled report delivery (Enterprise gate starts here) | Fleet manager | Community (read-models + dashboards); Enterprise (scheduled delivery) | Medium | 4-6 |
| **H — Scale + Multi-region** | Migration 0032/0033 (partition audit_events + notification_events by occurredAt RANGE monthly) + migration 0034 (odometer_readings time-series, BRIN-indexed) | All | Community (partitioning); Enterprise (multi-region) | Medium-High (online partition via attach-existing) | 3-5 |
| **I — Snipe-IT compat sunset** | FEATURE_SNIPEIT_COMPAT_SHIM deprecation 0.5 → notice 0.6 → removal 0.7 | — | Community | None | 2-3 |

**Total estimated PR cycles: 40-60 across 12-18 months.** Wave A-D
ships the perception-flipping core in ~6-8 weeks of focused
sessions; Wave E-H builds the procurement-credible compliance +
scale story; Wave I closes a tech-debt obligation.

## Per-wave detail

### Wave 0 closure (in flight — 1-2 weeks)

- **Round 6 PR2b**: executed restore drill against staging with
  observed RTO/RPO. Maintainer-hands-on (Supabase + S3 creds).
  Closes Wave 0 §8 acceptance.
- **Round 7 §9-10**: Privacy/ToS legal review (BLOCKING — needs
  counsel), status page (Upptime on GH Actions), SBOM CycloneDX +
  cosign keyless signing, v2 6-agent scan, ADR-0014 amendment with
  URL-flip go/no-go.

**Exit criteria:** Wave 0 acceptance 10/10 closed; hosted URL flip
executed; ADR-0014 amended; first design-partner outreach drafts
ready.

### Wave 0+ — Web foundation (3-5 PRs)

- **PR**: ADR-0021 `web-frontend-architecture.md`. Settles:
  features/ folder layout (`apps/web/src/features/{scheduling,reporting,maintenance,driver}/`),
  RSC vs client-fetch strategy (server components + revalidatePath
  default; client islands for drag/interactive), state management
  (URL-state for filters; React Server Actions for mutations),
  mobile route group separation (`(driver)/` distinct from
  `(authenticated)/`), data-fetching contract (no client-side
  fan-out N+1).
- **PR**: Web design-system primitives. `Button`, `Card`,
  `EmptyState`, `Toast`, `Modal` extracted from per-page CSS
  classes. Land in `packages/ui-kit` (already exists per the
  workspace layout).
- **PR**: Light theme. `color-scheme: light dark` + token-driven
  swap. Outdoor-driver readability prereq.
- **PR**: Role-aware `/` dashboard skeleton. Replace
  `redirect("/assets")` with persona-router: fleet manager →
  `/dashboard`; dispatcher → `/reservations/calendar`; driver →
  `/me`; maintenance tech → `/maintenance/queue?assignee=me`.
- **PR**: Tap-target audit + accessibility ground-truth pass.
  ≥48px touch targets; AA contrast on all status pills;
  status-by-text-not-colour everywhere.

**Exit criteria:** ADR-0021 Accepted; design-system primitives
available; light theme + role-aware `/` shipped; ux-critic signs
off that web is ready to host the feature waves.

### Wave A — Foundations (5-7 PRs)

Closes the directive's named "asset or car assigned to user or
team" feature.

**Decision #2 — hierarchical teams (maintainer choice, 2026-05-18).**
parentTeamId + tree structure. Mirrors corporate org charts. UX
must validate the tree depth doesn't drown the UI; ux-critic
gate before merge.

- **PR — Migration 0027**: `Team` + `TeamMembership` + hierarchy
  - `Team(id, tenantId, name, slug, description, parentTeamId, archivedAt, createdAt, updatedAt)` with `parentTeamId` self-FK ON DELETE SET NULL (orphans a subtree rather than cascading)
  - `TeamMembership(id, tenantId, teamId, membershipId, role, createdAt)` — FK to TenantMembership.id NOT User.id (cascade-delete via tenant membership)
  - Recursive CTE helper for "all descendants of team X" lookups
  - RLS policies extend; FORCE RLS on both tables
- **PR — Migration 0028a**: `AssetAssignment` table (effective-
  dated, GIST exclusion on primary-role overlapping ranges).
- **PR — Migration 0028b**: Drop fossil `Asset.assignedUserId`
  (verified unused; data-architect veto §9). Audit-chain
  unaffected.
- **PR**: Team admin UI under `(authenticated)/admin/teams/`.
  Hierarchical tree CRUD (drag-to-reparent, breadcrumb nav,
  collapse/expand). Uses Wave 0+ design primitives. ux-critic
  signs off on tree-depth-readability.
- **PR**: Asset assignment UI on asset detail page. "Assigned to:
  user X | team Y" effective-dated dropdown. Team selector shows
  full path (e.g., "Fleet Ops → North Region → Truck Pool").
- **PR**: Team-aware reservation filtering. "My team's
  reservations" view via recursive descendant lookup.
- **PR — persona walkthrough doc**: Fleet manager creates a
  3-level team tree (Fleet Ops → North Region → Truck Pool);
  assigns 5 vehicles to "Truck Pool" + 3 vehicles to individual
  drivers; dispatcher sees the assignments + filters calendar by
  "Fleet Ops" descendant tree.

**Exit criteria:** schema migrations Accepted by data-architect;
recursive descendant queries perform under 100ms at 1000 teams
× 5 levels deep; RLS policies tested for cross-tenant
non-bleeding; team + assignment surfaces in apps/web/; ux-critic
signs off on tree-depth UI; persona walkthrough doc shows fleet
manager + dispatcher journeys complete; FEATURE_TEAMS flag
default-on for all tenants.

### Wave B — Driver Native Mobile App (React Native / Expo) + photo-evidence GA (8-12 PRs)

**The wave persona-fleet-ops names as "the one that flips a paying
customer".** Closes ADR-0012 step 13 (FEATURE_INSPECTIONS canary)
+ ships the driver-mobile surface FleetManager v2.1 has and
Panorama doesn't.

**Decision #3 — native React Native / Expo (maintainer override,
2026-05-18).** product-lead anti-goal "no native mobile app
before PWA" was overruled by the maintainer. The native path costs
a second build pipeline, a second auth model, a second test
surface — captured in the Risk register below. Trade-off accepted:
ceiling for driver UX is higher, App Store / Play Store presence
is achievable, offline / camera / push notifications use native
APIs rather than service-worker / web-camera shims. Roadmap
adjusts accordingly.

- **PR — ADR-0022**: `driver-mobile-app-architecture.md`. Settles:
  workspace package layout (`apps/driver-app/` with Expo SDK +
  EAS Build), device-auth token model (Personal Access Token
  extension with `device_token` scope + short-lived JWT), offline
  storage shape (SQLite via Expo SQLite or WatermelonDB; conflict
  resolution = server-wins per ADR-0002 pattern), photo pipeline
  reuse (existing S3 presigned upload flow), navigation library
  choice (React Navigation), state management, build distribution
  channel (EAS internal track for design partners, App Store /
  Play Store for GA), CI pipeline (`eas build` + `detox` or
  `maestro` for e2e).
- **PR — Backend**: device-token PAT endpoint extension at
  `apps/core-api/src/modules/auth/`. New `PersonalAccessToken.scope`
  field already exists (per schema.prisma); add `device_token`
  scope + token-binding to a `(userId, deviceId)` tuple. Short-lived
  refresh-token rotation for security.
- **PR — Expo app scaffold**: `apps/driver-app/` workspace package.
  Expo SDK 50+ + React Native 0.74+ + TypeScript + React Navigation
  + Expo SQLite + Expo Image + Expo Camera. Build pipeline via EAS
  Build.
- **PR — "My reservations" screen**: driver's next + active
  reservation as full-bleed cards with one primary CTA each
  (Check out, Inspect, Return). API contract mirrors web's `/me`.
- **PR — QR deep-link** via Expo Linking (`panorama://r/:id` +
  Universal Links / App Links). Landing routes to the right action
  based on reservation status.
- **PR — Inspection flow**: native camera capture with offline
  draft via Expo SQLite. EXIF strip applied server-side at upload.
- **PR — Offline-first reservation list**: SQLite caches the
  driver's reservations; sync on signal return; server-wins
  conflict resolution per ADR-0022.
- **PR**: Flip `FEATURE_INSPECTIONS=true` as default. Close
  0.3 #4 canary; remove the flag conditional in backend code.
- **PR — CI gate**: `driver-native-smoke.e2e.ts` via Maestro or
  Detox against Expo dev client. Required before Wave B closes.
- **PR — Web `/me` minimal fallback**: a basic `/me` route in
  `apps/web/` for the rare driver who needs to use a desktop
  browser (e.g., a yard supervisor checking out vehicles for
  multiple drivers). NOT a primary surface; the native app is the
  primary driver UX.
- **PR — persona walkthrough doc**: Driver scans cab QR with
  native camera in 1 tap; lands in `panorama://r/:id`; checks out
  vehicle 47; runs pre-trip inspection with 3 photos on a
  5-year-old Android in airplane mode; arrives at depot; signal
  returns; photos upload; driver checks vehicle in 3 hours later.

**Exit criteria:** ADR-0022 Accepted; Expo app builds via EAS;
native QR scan + check-out + offline-inspection + sync working;
FEATURE_INSPECTIONS=true default; driver-native-smoke gate in CI;
App Store / Play Store TestFlight + Internal Track listings
ready; persona walkthrough demonstrates 1-tap QR + offline
inspection. **This wave's success is the canary signal for the
hosted instance's public differentiation.**

### Wave C — Dispatcher Power Tools (4-6 PRs)

Closes persona-fleet-ops's "5am vehicle down" + "10-minute dead
loss reassignment" scenarios.

- **PR**: Calendar drag-to-reschedule. Client-island over the
  existing SSR-CSS-grid calendar; optimistic + Server Action
  confirm. Preserves the "Zero client JS" moat for non-interactive
  viewing.
- **PR**: Overlap-warning indicator on rows where reservations
  touch (accessibility: text-prefix + status pill, not just
  colour).
- **PR**: Bulk approve with optimistic-lock proof (`optimisticLockVersion`
  per reservation). Closes FleetManager v2.1's H19 (notification-
  before-commit) race.
- **PR**: "Affected reservations" view on maintenance ticket
  detail page. From a ticket, list every reservation overlapping
  the maintenance window with 1-click "reassign to a different
  asset" action.
- **PR — persona walkthrough doc**: Dispatcher flags vehicle 47
  unavailable at 05:23; sees 3 affected reservations on screen;
  bulk-reassigns to vehicles 42, 51, 58 in <2 minutes total.

**Exit criteria:** dispatcher click-cost for "rebook reservation"
drops from ~5 clicks to ≤2; bulk approve doesn't double-emit
notifications; persona walkthrough doc shows 5am scenario complete.

### Wave D — Fleet Manager Dashboard + Reports v1 (4-6 PRs)

Closes persona-fleet-ops's "month-end reporting MVP" + first-5-min
dashboard scenarios.

- **PR**: `/dashboard` route (replaces the Wave 0+ skeleton with a
  populated KPI band): "X vehicles down, Y inspections failed
  overnight, Z reservations today, N pending approvals". Text-first;
  cards from Wave 0+ primitives.
- **PR**: 5 canned reports
  - **Utilisation by asset** (reservedMinutes / inServiceMinutes per asset, last 30/90 days)
  - **Mileage by driver** (sum of mileageIn - mileageOut per requesterUserId)
  - **Maintenance cost by asset** (sum of MaintenanceTicket.cost group by assetId)
  - **Missed reservations count by driver** (queued but never checked-out)
  - **Damage incidents** (count of damageFlag=true group by asset and driver)
  Each report CSV-export via existing `TenantExport` infrastructure.
- **PR**: Saved-report configuration (which canned report + which
  parameters + per-tenant default selection).
- **PR — persona walkthrough doc**: Fleet manager opens Panorama
  at 7am; sees overnight failures + pending approvals in 0 clicks;
  exports utilisation CSV for board meeting in 2 clicks.

**Exit criteria:** 5 canned reports produce correct counts against
seeded staging data; dashboard renders in <500ms (RSC); persona
walkthrough doc shows fleet manager journey complete.

### Wave E — Maintenance Power Tools (4-6 PRs)

Closes persona-fleet-ops's "maintenance tech morning huddle" + ships
per-asset PM cadence (current per-tenant fallback is wrong for
mixed fleets — truck PM at 7500mi, forklift at 250hrs, generator at
calendar quarter).

- **PR — Migration 0030**: `MaintenanceSchedule` table (per-asset
  or per-category PM schedules with mileage/day/hours triggers +
  next-due derivation). `Asset.hourMeter + lastReadHours` columns.
- **PR**: PM-due sweep job updates `nextDueAt` daily via existing
  BullMQ infrastructure.
- **PR**: `/maintenance/queue` view — PM due today + overdue + reactive
  opened in last 24h. Grouped by assignee with "next ticket"
  shortcut.
- **PR**: Parts/labour line items on MaintenanceTicket detail.
  Cost capture, photo evidence per item.
- **PR — persona walkthrough doc**: Maintenance tech opens phone at
  6am; sees 3 PM-due + 1 overdue + 2 reactive overnight in 0
  clicks; completes one ticket with 2 photos + 1 part in 4 clicks.

**Exit criteria:** PM cadence accurate for mileage + time + hours
trigger combinations; queue view loads in <300ms; persona
walkthrough doc shows morning huddle complete.

### Wave F — Reservation Engine v2 (3-5 PRs)

Recurring reservations + soft holds. Highest-hazard wave for
migrations (enum extension + exclusion constraint rebuild).

- **PR — Migration 0029a**: `ReservationSeries` table with RRULE
  text column (no parsing in DB; service-layer materialises
  instances 90d ahead).
- **PR — Migration 0029b**: Standalone migration that ALTERs the
  `reservation_status` enum to include `'HELD'`. PG14+ allows
  transactional ALTER TYPE ADD VALUE.
- **PR — Migration 0029c**: Online rebuild of `reservations_no_overlap`
  exclusion constraint to include `'HELD'` in the in-play list.
  `CREATE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX`
  pattern. Pre-rehearsed on staging at production-equivalent row
  count.
- **PR**: Recurring bookings UI on reservation create form.
- **PR**: Soft-hold sweep job (releases stale holds via existing
  BullMQ).

**Exit criteria:** recurring bookings cannot smuggle conflicts
through the exclusion constraint; soft holds release on
`heldUntil`; persona walkthrough doc shows dispatcher creating a
"every Tuesday for 12 weeks" booking.

### Wave G — Reporting v2 + Read-Models (4-6 PRs)

Heavier reporting + Enterprise gate starts here.

- **PR — Migration 0031**: `asset_utilisation_daily` +
  `tenant_kpi_daily` rollup tables. Cron-refreshed at 03:00
  tenant-local. Partitioned by `day` quarterly with BRIN index.
- **PR**: Per-module reporting views (each module owns its own
  `*.reporting.view.sql` migration).
- **PR**: Reporting aggregator service — thin SQL-runner respecting
  RLS via `runInTenant`. **No cross-module service imports per
  tech-lead veto.**
- **PR**: Dashboard v2 powered by rollups (sparklines, trend
  comparisons).
- **PR — Enterprise scaffolding**: Scheduled report delivery
  (XLSX/PDF). Lands behind `FEATURE_SCHEDULED_REPORTS` flag;
  promoted to Enterprise on first paid pilot signal.

**Exit criteria:** rollup refresh under 30s for staging-sized
tenants; reporting-RLS smoke gate in CI (every reporting view
returns zero rows under a wrong-tenant session); persona walkthrough
doc shows fleet manager exploring trends over 90 days.

### Wave H — Scale + Multi-region (3-5 PRs)

Production-load hardening + Enterprise wedge.

- **PR — Migration 0032**: Partition `audit_events` by `occurredAt`
  RANGE monthly. Online migration via attach-existing-as-partition.
  Trigger functions unchanged.
- **PR — Migration 0033**: Partition `notification_events`; per-
  tenant retention drops partition not rows.
- **PR — Migration 0034**: `odometer_readings` time-series table
  with BRIN index on `readAt`. Telematics-ready data shape.
- **PR — Enterprise**: Multi-region read-replica architecture
  ADR + scaffolding (Enterprise repo).

**Exit criteria:** chain-verify at 100M-row scale completes within
the staging-drill SLO; partition drops working in staging;
multi-region ADR Accepted.

### Wave I — Snipe-IT compat sunset (2-3 PRs)

Tech-debt closure per tech-lead recommendation.

- **PR 0.5**: Deprecation notice on FEATURE_SNIPEIT_COMPAT_SHIM
  surfaces. Banner in admin UI; deprecation log on every endpoint
  call.
- **PR 0.6**: Notice escalates; compat shim emits 410 Gone on
  endpoints with declared sunset dates.
- **PR 0.7**: Remove `apps/core-api/src/modules/snipeit-compat/`
  + `packages/plugin-sdk` Snipe-compat hooks.

**Exit criteria:** zero in-flight Snipe-IT migrations cited on
support channels; compat-shim removal merged.

## Anti-goals (universal across agents)

Things we explicitly do NOT do, even when they look tempting:

- **No predictive ML in Community.** Buzzword inflation, no
  validating signal, ops burden. Telematics + predictive lives in
  Enterprise after a customer asks by name.
- **No "AI-powered" UI strips on every page.** Performative noise.
- **No GraphQL.** REST endpoints + RSC composition.
- **No event-bus refactor "for reporting".** NotificationModule
  already exists; reporting reads from rollups + views, not events.
- **No generic `BaseService<T>` / repository pattern.** Prisma is
  the repository.
- **No `DataTable<T>` mega-component with 14 props.** Per-feature
  tables; extract only at the third copy.
- **No modal-stacking.** Linear discipline: route, don't modal.
- **No side-drawer with a form that should be a page.** >5 fields
  or any tabs = page.
- **No infinite scroll on operational tables.** Paginate; ops users
  count rows.
- **No pie charts.** Useless at the comparison densities fleet
  managers need.
- **No hamburger nav on desktop.** Five primary items fit
  horizontally.
- **No dark-pattern "Are you sure?" with a default-destructive
  button.** Destructive always defaults to cancel.
- **No toasts as the only error feedback for destructive actions.**
  Inline error + page banner; toasts evaporate.
- **No onboarding tours/coach marks on first login.** Fleet ops
  don't have time; UI must be self-evident.
- ~~**No native mobile app before web mobile-responsive PWA.**~~
  **Overridden by maintainer decision 2026-05-18.** Wave B ships
  native React Native / Expo. The product-lead anti-goal is
  preserved as a historical record; the chosen path accepts the
  higher build/test cost in exchange for native UX ceiling.
- **No real-time fleet map demo.** "I know where my buses are. My
  drivers tell me. I don't need a GPS dot." (persona-fleet-ops)
- **No in-app chat.** Customers have WhatsApp/Teams.
- **No gamification / driver leaderboards.** Union grievance trap.
- **No fuel-card integrations** until a customer names a specific
  card.
- **No SOC-2 Type II spend pre-revenue.** Type I in 1.0 is enough.
- **No Enterprise repo creation until paid pilot signal.** "No
  Enterprise SKU until a customer asks for one by name and the
  asking is recorded in a sales artefact, not a roadmap doc."
  (product-lead)

## Non-negotiables (engineering discipline)

Enforced through code review + agent committee veto:

1. **Two-phase migrations** for any NOT NULL on tenant-scoped
   tables. Add nullable + backfill + flip in separate migrations
   with ROLLBACK.md per phase.
2. **Every new tenant-scoped table** gets RLS policy + rls.sql +
   FORCE RLS. The audit-events-tenant-read precedent (migration
   0001 / rls.sql:152-154) is the template.
3. **Every migration has a `ROLLBACK.md`** documenting the revert
   path. No "we'll figure it out later".
4. **ADRs land BEFORE or WITH implementation, never after.**
   ADR-0021 lands before any Wave 0+ frontend PR. Same pattern for
   every wave.
5. **No cross-module service imports.** Reporting reads from views,
   not service methods. Teams expose `TeamGuard` + request-context,
   not direct imports.
6. **Feature-flag gating pattern** for every new wave feature.
   Default-off until canary completes; flip-to-default-on in a
   separate PR with a per-PR scan.
7. **5-agent per-PR scan** before merge on any wave PR.
   tech-lead + data-architect + security-reviewer + product-lead +
   persona-fleet-ops in parallel; iterate to Accepted via blocker
   deltas.
8. **Persona walkthrough doc** per wave. Documents the 4-persona
   journeys end-to-end; lives at `docs/audits/walkthrough-wave-<X>-2026-MM-DD.md`.
9. **No `audit_events` mutation.** Append-only forever. No UPDATE.
   No DELETE. Any historical reshape needs a new table.
10. **No `INHERITS` partitioning.** Declarative `PARTITION BY
    RANGE` only.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **No real customer signal** to validate persona assumptions | High | Wave 0 closure + URL flip + explicit design-partner recruitment (3 partners, weekly call) before Wave A scope-locks |
| **Stack depth fatigue** in long Wave sessions degrades per-PR scan signal | Medium | Session-end memory from 2026-05-17 documents the pattern; cap sessions at ~10 PRs |
| **Migration 0029c exclusion rebuild** hazardous at scale | High | Pre-rehearse on staging at production-equivalent row count; canary first; rollback to additive-only schema if rebuild stalls |
| **Driver mobile offline mode** introduces sync conflict surface | Medium | ADR'd in Wave B; service-worker draft pattern with server-wins on conflict; first design-partner validates |
| **Snipe-IT compat sunset** breaks unknown self-host migrations | Medium | 3-release deprecation window (0.5 → 0.6 → 0.7); explicit migration guide before removal |
| **Audit chain immutability** forces extra-careful schema work | Medium-High | data-architect veto on every audit-touching PR; chain-verify CLI in every CI smoke |
| **Enterprise positioning ahead of revenue** weakens Community pitch | Medium | "Forward-looking" framing already in feature-matrix; no Enterprise repo until paid signal |
| **Web architecture debt** (5 components total) explodes during Wave B-C | Medium | ADR-0021 + Wave 0+ design primitives before any feature wave |
| **Native mobile app build + test surface** (Wave B Decision #3) | Medium-High | Maintainer accepted trade-off explicitly. Mitigation: ADR-0022 settles Expo + EAS Build + Detox/Maestro pipeline before any Wave B code; CI gates expand; first design partner installs via TestFlight / Play Internal before App Store / Play Store GA |
| **Hierarchical teams UI complexity** (Wave A Decision #2) | Medium | ux-critic explicit gate on tree-depth readability; max depth recommendation 4 levels; persona walkthrough doc must show fleet manager navigating tree without confusion |
| **Maintainer bus-factor of 1** during multi-month roadmap | Medium-High | Already known (issue #50); roadmap doc itself is partial mitigation; ADRs at every wave create transferable knowledge |
| **Reporting RLS surface** is the highest-risk new attack vector | Medium | `reporting-rls.sql.test` gate before Wave G; security-reviewer veto on every reporting PR |

## Decision points — RESOLVED (2026-05-18)

Maintainer decisions logged from the 2026-05-18 planning round:

1. **Wave A vs Wave B ordering — RESOLVED: Wave A first (Teams +
   AssetAssignment).** Confirms product-lead + tech-lead +
   data-architect recommendation. Driver native app in Wave B
   then references assigned-to-user/team relationships from day
   one. Safer sequencing; doesn't risk shipping driver UX twice.
2. **Teams hierarchy — RESOLVED: hierarchical (parentTeamId tree
   structure).** Migration 0027 includes self-referential FK +
   recursive CTE support. Mirrors corporate org charts. ux-critic
   has explicit gate on tree-depth UI before merge to ensure the
   tree doesn't drown the admin surface.
3. **Driver mobile shape — RESOLVED: native React Native / Expo
   app.** Maintainer overrode product-lead's "no native mobile
   before PWA" anti-goal. Wave B grows from 5-8 PRs to 8-12 PRs
   to absorb the second build pipeline + device-token auth model
   + second test surface (Detox or Maestro). New ADR-0022 will
   land before any Wave B code. A minimal web `/me` fallback ships
   alongside for desktop-only edge cases (yard supervisor
   checking out for drivers).
4. **Roadmap commit — RESOLVED: separate planning PR off main.**
   Branch off main; PR opens for review; doesn't bundle with the
   in-flight #240 / #241 PRs.

## Decision points awaiting maintainer (deferred until later waves)

5. **Reporting freshness:** real-time event-driven, or "refreshed
   every 5 min via materialised view" / rollup table cron? (Affects
   whether Wave G is migrations-only or needs an event-driven
   refresh worker. tech-lead Q3 + data-architect §6.) Maintainer
   weighs in at Wave G planning.
6. **Design-partner outreach timing:** product-lead suggests "after
   URL flip, before Wave A scope-locks". Whose conversations to
   prioritise (Amtrak/FDT reconnect? new outreach? friendly
   self-hosters who installed Panorama?) Maintainer weighs in
   during Round 7.
7. **Enterprise repo timing:** product-lead recommends "no
   Enterprise repo until paid pilot signal". Conservative; some
   features (SCIM, white-label) need Enterprise infrastructure to
   ship. When does Enterprise repo creation become the bottleneck?
   Maintainer weighs in when first paid-pilot signal lands.

## Synthesised agent reports (appendix)

The full 5-agent reports from the 2026-05-18 planning round live
in the conversation transcript. Per-agent contributions
synthesised here:

- **product-lead** (37K tokens, 7 sections): Vision + edition
  placement + wave structure + Wave 0 hygiene + anti-goals +
  customer-discovery gaps + URL-flip impact. Stance: SUPPORT with
  named scope discipline.
- **data-architect** (68K tokens, 9 sections + 8-row migration
  sequence): Current schema assessment + Team model + AssetAssignment
  + Reservation extensions + PM cadence + Reporting layer +
  Multi-tenant scale + Migration sequencing + Veto list. Stance:
  Approved with schema sequencing 0027-0034.
- **tech-lead** (32K tokens, 9 sections + F0-F8 wave structure +
  3 open questions): Module boundaries + backend-frontend balance +
  apps/web/ readiness + sequencing + abstraction-cost veto + plugin
  SDK + CI gates + migration safety + tech-lead veto list. Stance:
  REQUEST-CHANGES (on roadmap framing — ADR-0021 required first).
- **ux-critic** (45K tokens, 9 sections + per-persona journeys):
  Current UI assessment + persona gaps (4 personas) + driver mobile
  + calendar recommendation + dashboard density + accessibility +
  i18n + polish timing + UX veto list. Stance: REQUEST-CHANGES
  (on roadmap framing, before any code ships).
- **persona-fleet-ops** (53K tokens, 9 sections + "one wave that
  flips" call): What FleetManager v2.1 does well + what it does
  badly + per-persona "first 5 min" + 5am scenario + month-end
  reports + new driver day 1 + maintenance huddle + what NEVER to
  pay for + what would ABSOLUTELY pay for. Stance: CHANGES-REQUESTED
  for the roadmap. "Ship Driver Mobile PWA + photo-evidence GA as
  Wave B."

The reports include file:line references throughout. The
synthesis in this document represents committee convergence with
the named divergences (Wave A vs B ordering) flagged for
maintainer decision.
