# Handoff — 2026-05-17 (Round 4 complete)

> Continuation of `HANDOFF-2026-05-17-round-3-complete.md`. Round 4 of
> the 7-round revised plan from `HANDOFF-2026-05-16-wave0-scan.md` is
> now complete. All five Round 4 items are in main behind their merged
> PRs.

## TL;DR

- **5 PRs merged on 2026-05-17** (same day as Round 3 close), shipping
  the daily-driver UX from Wave 0 §"Round 4".
- Apps/web now has a real test harness (vitest + RTL + jsdom) — all
  subsequent web PRs can ship with regression coverage.
- Shell + nav reordered to ops verbs; tenant + admin overflows
  consolidated; mobile breakpoint shipped.
- Reservations rows now carry actor names + a "this asset returned
  damaged last shift" cue.
- Approvals queue is now the admin landing view, with deterministic
  concurrency on approve/reject via `pg_advisory_xact_lock`.
- Per-tenant `autoOpenMaintenanceFromInspection` toggle has an admin
  UI; the schema field already existed since the maintenance feature
  shipped.
- **Round 4 of the 7-round plan = DONE.** Rounds 5-7 remain before
  the hosted URL can flip.

## PRs in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 217 | `40980ef` | Vitest + RTL + jsdom + login smoke test | Foundation. First test infra for apps/web. New `web-test` CI job. |
| 218 | `263f4b8` | Shell/nav reorder + overflow menus + PageHeader | ~20 files; primary nav now Calendar → Reservations → Inspections → Assets → Maintenance; admin overflow + user overflow `<details>`; PageHeader adopted across 12 authenticated pages; mobile @media 720px breakpoint. |
| 219 | `620433e` | Reservations actor-on-row + previous-damageNote | Backend joins approver/checkedOutBy/checkedInBy User.displayName + per-asset most-recent damaged-return scan. Persona-fleet-ops same-day-swap regression test included. |
| 220 | `b877458` | Approvals queue surface + advisory-lock concurrency | Default-filter flip for admins on `/reservations`; `pg_advisory_xact_lock(hashtext('reservation:'||id))` inside the SERIALIZABLE tx makes second admin's approve deterministically `not_pending:approved`. Stale-row banner i18n added. |
| 221 | `1a50c26` | Tenant settings page + autoOpenMaintenanceFromInspection toggle (#48) | New `/admin/settings` route + `GET/PATCH /tenants/:tenantId/settings` endpoints (Owner-only PATCH, fleet_admin-read). `panorama.tenant.settings_updated` audit row on real change. 15 i18n keys. |

## Numbers

- Session length: same working day as Round 3 close (2026-05-17)
- PRs shipped: 5 (all squash + `--admin` bypass — solo-repo branch
  protection)
- Tests added: 13 web RTL tests + 4 backend e2e cases (actor-name,
  prev-damage, same-day-swap, concurrent-approve, concurrent-approve-
  reject, tenant-settings 7-case)
- Suite total — web: 13/13 (was 0); core-api: 488/488 (was 476 after
  Round 3; +12 from PR3 + PR4 + PR5)
- Lines of TypeScript / TSX added: ~2400 across `apps/web/`,
  `apps/core-api/`
- Lines of CSS added: ~330 in `apps/web/src/app/globals.css`
- Lines of i18n added: 14 + 4 + 3 + 4 + 15 = 40 new keys per locale
  (× 3 locales = 120 total entries)

## Decisions locked this round

1. **Test infra: vitest + jsdom + @testing-library/react 16 + jest-
   dom matchers**, mirroring core-api's vitest 3.2.4 baseline. Server-
   only marker is shimmed under vitest only (build-time guarantee
   preserved by Next).
2. **Primary nav order: Calendar → Reservations → Inspections →
   Assets → Maintenance.** Calendar first because the 5:30am
   coordinator wants the schedule before drilling into rows. Admin
   items collapsed under a single "Admin ▾" `<details>` overflow.
3. **User-menu overflow** — tenant switcher + sign-out collapsed into
   a `<details>` triggered by the username chip. Frees ~120px of
   header width. Native widget, no client-state needed. Esc-to-close
   deferred to Round 5/6 (filed as TODO in JSDoc).
4. **PageHeader.title is ReactNode**, not string. Pages can append a
   count pill or status badge inline with the heading. JSDoc rule:
   textual content MUST come first inside the ReactNode.
5. **Per-asset previous-damage predicate** (PR3): dropped the
   `prev.checkedInAt < r.startAt` guard per persona's same-day-swap
   scar. Predicate is now "ANY most-recent damaged-return on this
   asset" — surfaces whenever the asset has prior damage, regardless
   of date order vs the current row's startAt.
6. **Approvals queue default-flip** (PR4) — when admin lands on
   `/reservations` with NO query params, default to
   `scope=tenant&status=pending`. Action-return redirects (which
   carry banner params) bypass the flip so admins don't lose their
   manually-selected scope.
7. **Concurrency on approve/reject** (PR4) —
   `pg_advisory_xact_lock(hashtext('reservation:'||id))` at the top
   of the `decideWithin` tx. SERIALIZABLE is still the correctness
   backstop; the advisory lock makes the loser path deterministic
   (`not_pending:{status}` instead of `serialization_failure`).
8. **Tenant settings authz split** (PR5) — GET requires
   `currentRole ∈ {owner, fleet_admin}` (transparency about ops
   policy is fine); PATCH requires `currentRole === 'owner'`. Three
   independent authz gates (controller + runInTenant GUC + Tenant
   self-scoping RLS).
9. **`autoOpenMaintenanceFromInspection` default-OFF.** Existing
   field default unchanged. A CMMS-using fleet upgrading shouldn't
   suddenly start auto-creating tickets; the operator opts in via
   the new settings page.

## Iterative review pattern reinforced

Per-PR `tech-lead + security-reviewer + ux-critic + persona-fleet-
ops` 4-agent scan before commit. Cadence across the 5 PRs:

- PR 217 needed 0 iterations (test-infra-only; ux-critic + persona
  said "nothing in my lane"; tech-lead + security-reviewer approved
  on first pass).
- PR 218 needed 1 iteration. ux-critic + persona both raised
  REQUEST-CHANGES on a11y + mobile + tenant pill contrast + heading
  redundancy. All closed in rev1.
- PR 219 needed 1 iteration. persona-fleet-ops raised CHANGES-
  REQUESTED on the same-day-swap predicate (a real workflow bug).
  All closed in rev1.
- PR 220 needed 1 iteration. tech-lead raised REQUEST-CHANGES on
  dead `not_pending:cancelled` code + default-flip narrowing + lock
  comment. All closed in rev1.
- PR 221 needed 1 iteration. ux-critic raised REQUEST-CHANGES on
  enum-leaked copy + a11y read-only-notice placement + inline-style
  regression. All closed in rev1.

The pattern continues to be the right cadence — agents find real
issues every pass, and addressing them in-PR keeps the followup
backlog focused on genuinely deferrable items.

## What's left (Rounds 5-7 of the 7-round revised plan)

### Round 5 — CI + observability + secret rotation

- **#49 ensure-community-complete CI** promotion from grep to
  functional — **HARD PREREQUISITE for URL flip**
- Observability stack per ADR-0018 (pino + Sentry opt-in +
  RequestContextMiddleware)
- `SESSION_SECRET` secondary-key support (iron-session array
  config) per maintainer decision 2026-05-16

### Round 6 — runbooks

- `docs/runbooks/incident.md` (LGPD 72h ANPD clock + breach
  taxonomy)
- `docs/runbooks/restore.md` + restore drill executed once
- `docs/runbooks/secrets-rotation.md` using inventory from
  Round 1
- Register controlled domain + `.well-known/security.txt`

### Round 7 — pre-launch + v2 scan + URL flip go/no-go

- Privacy + ToS at `apps/web/src/app/legal/*` (LGPD Art. 9)
- Status page (Upptime on GH Actions)
- SBOM CycloneDX + cosign sigstore keyless sign on release
- README "Backend: production-ready" softened
- Hosted-vs-self-host CTA tracking
- v2 6-agent scan on the closed-blocker delta
- URL flip go/no-go decision recorded as ADR-0014 amendment

## Follow-ups deferred during Round 4 (not blockers; tracked here)

**From PR 217 (vitest infra):**
- CI duplicate-install consolidation across `web-test` + `test` +
  `lint` jobs

**From PR 218 (shell/nav):**
- Esc-to-close handler on user-menu + admin-overflow `<details>` —
  Round 5/6 polish before public preview
- PageHeader `meta?: ReactNode` slot split (ux-critic Round 5 polish)
- Hoist calendar filter strip from inline `<nav>` to a `.panorama-
  filter-strip` class

**From PR 219 (actor-on-row + prev damage):**
- Partial index `reservations (tenantId, assetId, checkedInAt DESC)
  WHERE damageFlag = true AND checkedInAt IS NOT NULL` — lands if
  endpoint p95 > 100ms in canary
- `DISTINCT ON (assetId)` / windowed CTE to replace `take: 500` cap
- Hide checked_out_by once checked_in_by exists (ux-critic five-
  item lifecycle cell)
- PanoramaCallout component extraction (ux-critic — 4 inline
  amber callouts now)
- Link prior-damage callout to prior maintenance ticket
- Prior-damage visibility on CHECKED_OUT rows for un-checkout edge
- Cross-tenant displayName test (persona)

**From PR 220 (approvals queue + advisory lock):**
- Banner with WINNER's name on stale-row (persona) — requires post-
  error row fetch in the server action
- `$executeRawUnsafe` → tagged-template `$executeRaw` (cosmetic)
- Zod uuid validation on path params (defense-in-depth sweep)

**From PR 221 (tenant settings):**
- "Last changed by X on Y" surface under the toggle
- Confirmation step on Owner flip
- Concurrency UX (post-flip stale-state refresh, persona)
- "Request change" affordance for fleet_admin to nudge an Owner
- Audit-row history view at /admin/settings
- `panorama.tenant.settings_viewed` cluster-readable read event
- Drop hidden tenantId input — read from session server-side
- Contributing-guide note "audit metadata: never persist
  secrets/PII unhashed" (before the SECOND setting field ships)

## How to pick up the next session

1. **Read this handoff first.** Then `HANDOFF-2026-05-16-wave0-
   scan.md` for the round-by-round plan; `HANDOFF-2026-05-17-round-
   3-complete.md` for the Round 3 context.
2. **Start Round 5 from a fresh branch off main.** Round 5 is the
   CI #49 functional gate + observability + SESSION_SECRET rotation
   triad. The #49 promotion is the HARD PREREQUISITE for the URL
   flip — start there.
3. **Per-PR scan stays mandatory.** Round 5 is infrastructure +
   observability — bring in `tech-lead + security-reviewer +
   data-architect` as the primary trio; `ux-critic + persona-
   fleet-ops` may have nothing to review on infra PRs (acceptable
   per Round 4's pattern).
4. **No new migrations from Round 4.** Schema unchanged this round
   — the toggle's column already existed.
5. **`FEATURE_SELF_SERVE_SIGNUP` continues default off in prod.**
   The hosted URL flip is gated by ALL 10 Round 7 acceptance
   criteria per `HANDOFF-2026-05-16-wave0-scan.md` §"Wave 0
   acceptance".
6. **Branch-protection bypass via `--admin`** stays the pattern
   for solo-repo squash merges.

## Files newly authoritative in main

- `apps/web/vitest.config.ts` + `apps/web/test/_setup.ts` +
  `apps/web/test/_shims/server-only.ts` (PR 217)
- `apps/web/src/components/page-header.tsx` + tests (PR 218)
- `apps/web/src/app/(authenticated)/admin/settings/` (PR 221)
- `apps/web/src/components/app-shell.tsx` — heavily refactored
  (PR 218, PR 221 added "Settings" to admin overflow)
- `apps/web/src/components/app-nav.tsx` — primary/admin split,
  inline styles dropped, JSDoc rev1 TODO docs (PR 218)
- `apps/web/src/app/globals.css` — ~330 new lines for shell, nav,
  page-header, mobile @media, tenant pill, settings toggle,
  sr-only utility
- `apps/core-api/src/modules/reservation/reservation.service.ts`
  — `ReservationListRow` enrichment + per-asset prev-damage scan
  + advisory-lock decideWithin (PR 219 + PR 220)
- `apps/core-api/src/modules/reservation/reservation.controller.
  ts` — `shapeListRow` enrichment (PR 219)
- `apps/core-api/src/modules/tenant/tenant-admin.service.ts` —
  `getSettings` + `updateSettings` (PR 221)
- `apps/core-api/src/modules/tenant/tenant-admin.controller.ts`
  — new `TenantSettingsController` (PR 221)
- `apps/core-api/src/modules/audit/audit-actions.ts` — new
  `TenantSettingsUpdated` action (PR 221)
- `.github/workflows/ci.yml` — new `web-test` job (PR 217)
- 3 i18n bundles (en, pt-br, es) — 40 new keys × 3 locales

## Risks / known-stale items

1. **`FEATURE_SELF_SERVE_SIGNUP=false` is still the only gate
   stopping public access today.** Round 4 doesn't change this.
   Discipline: do NOT flip the flag until URL-flip acceptance
   criteria close (Round 7 §"Wave 0 acceptance").
2. **`S3_*` env vars remain REQUIRED on every deployment** per
   Round 3 PR 216's ObjectStorageModule hoist. Unchanged from
   Round 3.
3. **Stack depth.** 5 Round-4 PRs landed in one session on top of
   Round 3's 5 PRs. The advisory-lock + same-day-swap predicate
   were both real workflow fixes that landed only because the
   4-agent scan surfaced them — without persona-fleet-ops
   pushback, the same-day swap would have been a silent bug. **Per-
   PR scans stay non-negotiable.**
4. **Round 5 #49 functional CI gate is a HARD PREREQUISITE** for
   the URL flip. Don't let it slip — it's the only Round 5 item
   that the URL flip explicitly blocks on.
5. **The new tenant-settings page is the first of its kind.** When
   a second toggle ships (e.g. notification preferences,
   reservation-policy defaults), the form's checkbox-presence
   contract MUST be respected per the JSDoc in
   `apps/web/src/app/(authenticated)/admin/settings/actions.ts`.
   The audit-metadata "never persist secrets/PII unhashed" rule
   needs to land in CONTRIBUTING.md before any field with sensitive
   values ships.

## Round-by-round status snapshot

| Round | Status |
|---|---|
| 0 — ADR scaffolding | DONE (#199) |
| 1 — Docs + a11y quick wins | DONE (#203) |
| 2A — Throttler wiring | DONE (#204 + #205) |
| 2B — Audit chain reproducibility | DONE (#206) |
| 3 prereqs — audit registry + env + throttler infra | DONE (#208 + #209 + #210) |
| 3 main — signup + verify + delete + export endpoints | DONE (#212 + #213 + #214 + #215 + #216) |
| **4 — daily-driver UX (vitest + shell + actor-on-row + approvals + settings)** | **DONE (#217 + #218 + #219 + #220 + #221)** |
| 5 — CI #49 functional gate + observability + secret rotation | NEXT |
| 6 — runbooks (incident + restore drill + secrets-rotation) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

The hosted URL flips when all 10 Round 7 acceptance criteria
close. We are 6/7 rounds in.
