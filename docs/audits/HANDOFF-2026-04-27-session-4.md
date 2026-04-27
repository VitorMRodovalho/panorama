# Audit Resolution Handoff — 2026-04-27 (session 4)

Continuation of `HANDOFF-2026-04-26-session-3.md`. Session 4 closed
**all PILOT-\* ship-blocker UI gaps** (#74, #75, #76, #77, #78), the
ARCH-15 missing event (#40), and made substantial progress on the
trilingual master finding (#44).

## Session 2026-04-27 (session 4) — what landed (8 merged PRs)

| PR | Issues / Scope | Notes |
|----|----------------|-------|
| #139 | #40 + #74 dominant slice | `MaintenanceTicketSubscriber` auto-suggest (damage check-in + FAIL/NEEDS_MAINTENANCE inspection); ADR-0016 v3 amendment supersedes the proposed `DomainEventSubscriber` primitive; migration 0016 (two per-trigger UNIQUE partial indexes); SAVEPOINT-bracketed 23505 catch in `openTicketAuto`; 409 conversion in manual `openTicket` |
| #140 | #74 final slice (PM-due cron) | `MaintenanceSweepService` daily BullMQ; UNION'd partial-index queries; per-asset Redis SETNX 24h dedup; audit emissions batched into single super-admin tx; migration 0017 mileage-arm partial index |
| #141 | #77 PILOT-04 + #48 OPS-04 | `ReservationSweepService` with overdue (`CHECKED_OUT past endAt → isOverdue=true`) + no-show (`BOOKED past startAt+pickupWindow → MISSED`) sweeps; migration 0018 `Reservation.isOverdue` boolean discriminator + partial index; web red pill + new `overdue` filter tab; per-tenant `pickupWindowHours` from `reservationRules` |
| #142 | #78 PILOT-11 | Shared nav shell — route group `(authenticated)/` + `AppShell` (server) + `AppNav` (client, path-aware); 5 page folders moved via `git mv` (URLs unchanged); ~600 LOC duplicated header/nav/sign-out boilerplate stripped |
| #143 | #76 PILOT-05 | Blackout management admin UI — `/admin/blackouts` page (create form + active/upcoming/past/all filters + per-row delete with required-checkbox forcing function); calendar deep-link "+ Add blackout" |
| #144 | #75 PILOT-01 (ship-blocker) | Admin invitation-send UI — `/admin/invitations` page (send form + status-pill list + per-row resend + per-row revoke); 13 API errors mapped to i18n keys via `fmtErrorKey` |
| #145 | #44 phases 1+2 (UX-01/02/03/37) | Locale-aware first-impression flow — new `resolveRequestLocale()` (cookie → Accept-Language → 'en'); `<html lang>` dynamic in root layout; login + invitations/accept pages fully translated |
| #146 | #44 phase 3 partial (UX-04/06 + partial UX-30) | Assets + calendar pages translated; tenant-locale threaded through `toLocaleDateString` / `toLocaleString` on the calendar surface |

### Closing comments on issues

- #40 (ARCH-15) — closed by #139.
- #48 (OPS-04 damage check-in → ticket auto-open) — closed by #139's
  auto-suggest subscriber on the dominant trigger.
- #74 (PILOT-03 maintenance) — closed by #140 (final slice; backend
  + web + auto-suggest + PM-due cron all live behind FEATURE_MAINTENANCE).
- #75 (PILOT-01 admin invitations) — closed by #144.
- #76 (PILOT-05 blackouts UI) — closed by #143.
- #77 (PILOT-04 overdue sweep) — closed by #141.
- #78 (PILOT-11 nav shell) — closed by #142.
- #44 (UX-master trilingual) — **stays OPEN** with substantial progress.
  6 of ~12 sub-findings closed across #145 + #146. Ranked
  next-session task; continuation plan below.

### Reviews log

Two-pass parallel-agent review cadence used on PRs #139 + #140
(matching session-3 #132 cadence). PRs #141-#146 were push+merge per
direct user direction (`push+merge`); CI gates (typecheck + lint +
i18n parity + allowlist + tests) carried the verification load.

- security-reviewer two-pass on **#139** (auto-suggest): pass-1
  REQUEST-CHANGES on the multi-pod concurrent-open race;
  pass-2 APPROVE-WITH-NITS after migration 0016's per-trigger
  UNIQUE indexes + SAVEPOINT-bracketed 23505 catch closed the race.
- tech-lead two-pass on **#139**: pass-1 BLOCK on (a) ADR-vs-code
  drift around §5's `DomainEventSubscriber` primitive and (b) no
  DB-level guard against double-open; pass-2 APPROVE-WITH-NITS
  after ADR-0016 v3 + migration 0016 + the OR-merge catch fix.
- persona-fleet-ops one-pass on **#139**: SHIPPABLE-WITH-NITS;
  inspection title prefix (FAIL / NEEDS-MAINT) addressed pre-merge.
- tech-lead two-pass + data-architect two-pass + security-reviewer
  one-pass on **#140** (PM-due cron): data-architect REQUEST-CHANGES
  → APPROVE on 3 query-plan blockers (missing mileage-arm partial
  index, LIMIT 500 swallowing audit signals under multi-pod, 100+
  super-admin txes per pass); all addressed via migration 0017 +
  UNION rewrite + LIMIT 10k circuit-breaker + audit batching.

## Test baseline (after session 4)

- Backend: **370/370** tests pass (was 323 at session 4 start, +47
  net across PRs #139-141; PRs #142-146 were web-only and didn't
  add backend tests).
- Web: typecheck / lint / build all clean.
- i18n: parity at **372 keys/locale** EN/PT-BR/ES (was 188 at the
  end of session 3; +184 net across the session).
- runAsSuperAdmin allowlist: **29 calls across 12 files** (was 25/10
  at session 3 end; +4 calls in 2 new files —
  `maintenance-sweep.service.ts` budget=2,
  `reservation-sweep.service.ts` budget=2).

## State of the open audit registry

**30 issues open** as of session-4 end (was 37 at session-3 start).

**The pre-pilot ship-blocker UI gap list is empty.** All PILOT-\*
items closed in session 4. The remaining queue is steady-state
work — observability follow-ups, deferred edition-split features,
and the long-tail trilingual cleanup.

### Bucket — pre-pilot critical path (not blocking; canary-readiness)

- (none in scope as audit issues; see "Decisions for next session"
  below for canary rollout planning)

### Bucket — UX / web debt (steady state)

- **#44** UX-master trilingual — **NEXT SESSION'S TOP TASK**. 6 of
  ~12 sub-findings closed. Continuation plan below.
- #45 — broader nav/UX overhaul; pilot-minimal subset closed in #142,
  but the parent issue tracks dropdown menus + responsive sidebar +
  notification bell + keyboard shortcuts + search.
- #47 OPS-03 checkout form — two-field dropdown is too thin; needs
  compliance status + vehicle details + inspection link. M effort.
- #52 PROD-12 — broader "web UI ~10% complete" parent. With
  session 4's 4 new admin pages + nav shell + invitation UI, this is
  no longer ~10%. Worth re-scoping the issue body to reflect.

### Bucket — observability + soft follow-ups from session-4 reviews

(All low-to-medium priority; tracked here so they don't drift.)

- **`MaintenanceTicketSubscriber` audit-on-throw** (security-reviewer
  pass-1 soft on #139): immediate audit row on
  `asset_not_found` / `asset_cross_tenant` / `missing_tenant_id`
  throw paths in `maintenance-ticket.subscriber.ts`. Today only the
  dispatcher's eventual DEAD-letter audit fires after MAX_ATTEMPTS=5
  (~31 min backoff). Same shape needed for the
  `auto_suggest_skipped_flag_off` log-only path so a flag-flip
  backfill has a recoverable trail.
- **`MaintenanceSweepService` dedup-release warn** (security-reviewer
  pass-1 soft on #140): `releaseDedup`'s `del`-returns-zero path
  silently logs at debug; promote to warn so a Redis partition
  during release surfaces in alerting.
- **Chain-integrity test for batched `audit.recordWithin`**
  (tech-lead pass-2 soft on #140): regression test asserting
  `prevHash` of batched row N+1 equals `selfHash` of row N inside
  one super-admin tx. Locks the invariant against a future Prisma
  upgrade that changes tx-client read-your-own-writes.
- **#97** canary-watch on `audit_events` tail SELECT contention
  under sustained writer load — stays open until pilot tenant
  onboards.
- **#48 OPS-04** — formally closed by #139, but the broader "damage
  flag → ticket" persona scenario has a friction point: existing-
  OPEN ticket on the same asset → new damage signal goes into
  audit-only-skipped. Persona-fleet-ops "WRONG by my ops reality"
  feedback was acknowledged SHIPPABLE-WITH-NIT in #139. The v1.x
  fix is a UI change: surface `panorama.maintenance.auto_suggest_skipped`
  audits as "additional reports" on the existing ticket detail page.
- **`actorUserId=null` audit rendering** (persona-fleet-ops nit on
  #139): the maintenance detail page shows "system did it" when the
  audit row is system-attributed. Should render
  "system (on behalf of \<originalActorUserId\>)" — UI work, not
  backend.

### Bucket — Wave-2 / Wave-3 medium-priority (queued but not blocking)

- #59-61 NOTIF event catalog completion + plugin-sdk ghost events.
- #63 PERF-04 basket 5N queries.
- #64 PERF-02/07 invitation list filter push to DB.
- #113 audit chain per-tenant under panorama_app.
- #123 deps majors umbrella.
- #34 SEC-02 CSRF; #36 SEC-04 Trivy; #38 zero unit tests; #39 lint
  echo-stub; #50 PROD-08 bus factor; #53 Wave-1 medium/low rollup.
- #89-92 OIDC follow-ups; #96-98 audit-trigger follow-ups.
- #101 typescript-eslint ratchet; #109 web flat ESLint.

### Bucket — Enterprise edition slices (deferred per ADR splits)

- ADR-0016 §7 `MaintenanceEmailChannel` for
  `panorama.maintenance.next_service_due` (gated on
  `EditionService.isEnterprise()`).
- ADR-0009 + ADR-0011 `MaintenanceEmailChannel` for the other
  maintenance events (`opened` / `assigned` / `updated` / `completed`).
- Per-tenant `notifyLastRequesterOnMaintenanceOpen` UI surface.
- A similar email-channel for the new
  `panorama.reservation.flagged_overdue` /
  `panorama.reservation.no_show` audit rows from #141.

## Decisions needing maintainer input (Sprint 5+)

The following items are concrete and queue-ready. Recommend the next
session pick **one** to scope, ideally:

### 1. **#44 UX-05 reservations/page.tsx translation** (TOP PRIORITY)

The largest remaining trilingual chunk. ~80+ hardcoded strings.
Effort: M (~3 hours focused work; ~50 keys × 3 locales).

**Concrete starting points** (read these in order):

- `apps/web/src/app/(authenticated)/reservations/page.tsx` (785 lines)
- The page already has partial `messages.t(...)` wiring for
  approval / lifecycle / batch-skip-reason humanization — that
  scaffolding works, just needs to be extended to cover:
  - "New reservation" / "New basket" headings + form labels
  - Asset / Start / End / Approval / Lifecycle / Purpose / Actions
    column headers
  - Mine / Tenant scope nav + open / pending / approved / cancelled
    / overdue / all filter labels
  - Inline action buttons (Approve / Reject / Check out / Check in
    / Cancel) + confirm-panel labels
  - Batch action labels (Approve N pending / Reject N pending /
    Cancel N of M)
  - Banner success messages (`reservation created/cancelled/
    approved/rejected/checked-out/checked-in`)
  - The damage-callout block (already partially translated in #74
    web slice; verify completeness)
- The existing `apps/web/src/app/(authenticated)/reservations/actions.ts`
  redirects with `?error=<message>` strings that should also be
  i18n keys (or already are — audit). Same pattern for the basket
  batch error reasons (`reservation.batch.skip.*` keys exist
  already; complete coverage and remove the dynamic
  `humaniseBatchReason` string concat).
- Date formatting: `new Date(r.startAt).toLocaleString()` calls at
  multiple sites need the locale param threaded through (UX-30
  remainder).

**Risk:** the page is Next.js server component with many `?error=`
redirect URL params. Each error key needs to be a stable i18n key
the page resolves via `messages.t(sp.error)` rather than rendering
raw. The pattern is already established in #74 / #76 / #144 — same
shape applies.

### 2. **#44 UX-07-10 inspection module + admin pages**

Phase 4 of #44. Smaller per-page than UX-05 but more pages:

- `apps/web/src/app/(authenticated)/inspections/page.tsx` (mostly
  translated already from prior work; spot-check + fill gaps)
- `apps/web/src/app/(authenticated)/inspections/new/page.tsx`
- `apps/web/src/app/(authenticated)/inspections/[id]/page.tsx`
  (largest in this bucket; ~270 lines with question-rendering logic)
- `apps/web/src/app/(authenticated)/admin/inspection-templates/page.tsx`
- `apps/web/src/app/(authenticated)/admin/inspection-templates/new/page.tsx`

Effort: M (~50 keys × 3 locales).

### 3. **CI grep gate against hardcoded JSX English** (UX completion)

After UX-05 + UX-07-10 land, ship a gate script that fails the build
on JSX text nodes longer than 2 words without a `t(...)` wrapper.
Heuristic + allowlist for fixed identifiers like `pnpm` / `Snipe-IT`.
Effort: S (~1 hour). Lock in the trilingual invariant against future
regressions.

### 4. **Soft observability follow-ups bundle**

Pull together the three soft items from the session-4 reviews
(audit-on-throw + dedup-release-warn + chain-integrity test) into
one focused PR. Effort: S-M.

### 5. **FEATURE_MAINTENANCE canary rollout**

Same shape as the FEATURE_INSPECTIONS canary plan. Pick one pilot
tenant, flip `autoOpenMaintenanceFromInspection = true` on that
tenant, watch for 7 d:

- `panorama.maintenance.next_service_due` audit volume
- `pm_due_circuit_breaker_fired` log line (planner regression)
- `pm_due_audit_batch_failed` log line (chain integrity)
- `panorama.maintenance.auto_suggest_skipped` audit volume
  (existing-OPEN-ticket noise from persona's WRONG-by-my-ops-reality
  scenario)

After 7 d clean, flip the feature flag default to `true` for
Community.

### 6. Pilot tenant identification + onboarding

Out-of-scope for code work but on the critical path. Once a pilot
tenant is identified, item 5 (canary) starts.

If forced to rank by code-work value: **(1) → (3) → (2) → (4)**.
Ship UX-05 first because it unblocks the gate. Items 5 + 6 are
dependency-bound on external decisions.

## Working tree state at handoff

- Branch: `main`, up to date with `origin/main`.
- HEAD: `d0968e8`.
- No uncommitted changes (only `.claude/projects/` + `.claude/scheduled_tasks.lock`
  untracked, gitignored).
- All session-4 branches deleted post-merge.
- Tags unchanged from session 3: `pre-next15` (rollback target for
  #110, kept around).

## Known caveats

1. **3 pre-existing typecheck CJS/ESM errors** in core-api remain
   unchanged from session 3 (`import.service.ts:15`,
   `photo-pipeline.service.ts:10`, `import-roundtrip.e2e.test.ts:9`).
   Web typecheck is clean.

2. **#97 canary watch is intentionally open** until the first pilot
   tenant onboards. Don't try to close it pre-pilot.

3. **`FEATURE_MAINTENANCE` defaults to `false`** in
   `apps/core-api/.env.example`. Local dev `.env` (gitignored) sets
   it to `true` so smoke tests work; production / canary tenants
   flip on per-tenant when the canary rolls out (item 5 above).

4. **`autoOpenMaintenanceFromInspection` defaults to `false`** per
   tenant. Auto-suggest doesn't fire until a tenant explicitly
   opts in via DB SQL or the (yet-to-be-built) Enterprise admin UI.

5. **Per-trigger UNIQUE indexes (migration 0016) collapse** the
   same-reservation multi-FAIL case to one ticket — documented in
   ADR-0016 v3 §5 cross-trigger collapse paragraph. Persona
   acknowledged this as the ops-reality semantic: two FAIL
   inspections on the same reservation are almost always the same
   physical issue.

6. **Migration 0018 added `Reservation.isOverdue Boolean`**
   following the `isStranded` discriminator pattern (no enum bump,
   no exclusion-constraint change). Sweep is hourly setInterval —
   not BullMQ-durable. Acceptable for 1 h cadence; a Fly machine
   restart loses at most one cycle.

7. **Locale resolution precedence** for pre-session pages
   (`apps/web/src/lib/i18n.ts:resolveRequestLocale`):
   `panorama_locale` cookie → `Accept-Language` first segment → 'en'.
   Authenticated pages still prefer
   `loadMessages(membership.tenantLocale)` because the tenant's
   choice is more authoritative than the user's browser.

## Auto-memory pointers for the next session

- `MEMORY.md` index lists the project memory files. Update
  `project_session_2026_04_26_audit_resolution.md` post-session-5
  with the new totals (8 → ~9 PRs cumulative this audit-resolution
  sprint; 7 → ~8 issues closed; etc.). The maintenance memory file
  rename `project_03_5_maintenance_done.md` happened in session 4;
  if #44 closes entirely in session 5, do the equivalent for the
  trilingual story.
- `feedback_dont_leave_local.md` — standing authorization for
  push+merge happy path, still in force.
- `feedback_no_coauthor_trailer.md` — `Assisted-By:` trailer, never
  `Co-Authored-By:`. Verified across all 8 PRs from session 4.
- `feedback_adr_review_cadence.md` — parallel-agent ADR review
  pattern was used twice in session 4 (security-reviewer +
  tech-lead two-pass on #139 and #140). Pattern remains the right
  shape for ADR-touching PRs.

## Quick orient for the next session

- **TOP TASK: UX-05 reservations/page.tsx translation.** Read the
  starting points in §"Decisions needing maintainer input" item 1
  above. ~80 strings, ~50 keys × 3 locales. Pattern is well-
  established from #145 + #146 + the existing partial translations
  on the page itself.

- Open `gh issue list --label audit:wave-1 --state open` for the
  remaining medium/low Wave-1 items if you finish UX-05 quickly.

- Tests run via `pnpm --filter @panorama/core-api test` (370 pass)
  and `pnpm --filter @panorama/web {typecheck,lint,build}` from
  repo root. i18n parity gate: `pnpm i18n:check`.

- The dev stack is up — `docker_postgres_1`, `docker_redis_1`,
  `docker_minio_1`, `docker_mailhog_1` all running. No need to
  re-up infra for the next session.

- Migrations through 0018 already applied locally
  (`pnpm --filter @panorama/core-api exec prisma migrate status`
  → 18 migrations applied, db up to date).

- `apps/web/src/lib/i18n.ts` exports `resolveRequestLocale()` for
  pre-session pages and `loadMessages(locale)` for authenticated
  pages. New translations follow the established `messages.t(key,
  { interpolations })` pattern. Adding a new key requires the
  same value in EN + PT-BR + ES; `pnpm i18n:check` enforces
  parity.

— end of handoff —
