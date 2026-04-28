# Audit Resolution Handoff — 2026-04-28 (session 5, full)

Continuation of `HANDOFF-2026-04-27-session-4.md`. Session 5 spanned
**16 merged PRs** (vs. the prior session's 8) + **17 issues formally
closed**. The interim short-form handoff at `d3fd31c` (after PR #149)
covered the first three; this doc supersedes it with the full
session-5 picture.

## Session totals at a glance

- **PRs merged**: 16 (#147 → #163, plus #150 / #156 outside the
  numeric run for issue-hygiene closes)
- **Issues closed**: #34, #36, #39, #44, #59, #61, #63, #64, #89,
  #90, #91, #96, #97, #98, #101, #109, #113
- **Backend tests**: 370 → **408/408** (+38 net)
- **i18n parity**: 372 → **560 keys/locale** EN/PT-BR/ES (+188 net)
- **runAsSuperAdmin allowlist**: 29 calls / 12 files (unchanged)
- **Migrations**: 0018 → **0020** applied
- **typecheck**: was 3 pre-existing CJS/ESM errors → **0**

## What landed (full PR list, 16 merged PRs)

| PR | Hash | Closes | Theme |
|----|------|--------|-------|
| #147 | `30ba913` | #44 UX-05 | reservations/page.tsx + actions.ts trilingual; +96 keys/locale; `fmtErrorKey` pattern; 12-template batch banner refactor |
| #148 | `7ababcd` | #44 UX-07/08/09/10 | inspections module + admin/inspection-templates trilingual (5 pages + 2 actions); +89 keys/locale; `maybeErrorItemsParam` for `required_items_missing` |
| #149 | `3010be6` | #44 follow-up (CI gate) | `scripts/i18n-jsx-gate.ts` walks `apps/web/src/**/*.tsx` with the TS compiler API; rejects `JSXText` ≥ 2 letter-words outside the allowlist or `<code>`/`<pre>`/`<kbd>`/`<samp>` parents |
| #150 | `17e0d8f` | session-4 soft follow-ups | (a) `MaintenanceTicketSubscriber` audit-on-throw on every error path + flag-off skip audit; (b) `MaintenanceSweepService` `dedup-release-warn` + `del-returns-zero` warn promotion; (c) `audit-chain-integrity.e2e.test.ts` (5-row batched chain assertion + selfHash recomputability) |
| #151 | `a657e9b` | #34 SEC-02 | `CsrfOriginMiddleware` — Origin/Referer validation against `WEB_ORIGIN` allowlist on POST/PUT/PATCH/DELETE; pairs with existing SameSite=Lax. security-reviewer + tech-lead reviewed APPROVE-WITH-NITS, all nits folded pre-push (lift parsing into `AuthConfigService`, fail-closed on duplicate Origin headers, case-insensitive matching) |
| #152 | `6a3fc19` | #39 ARCH-05 | real ESLint on 4 workspace packages (`migrator`, `shared`, `plugin-sdk`, `ui-kit`); CONTRIBUTING.md aligned to reality; gate surfaced + fixed a real `String(unknown)` URL-param bug in SnipeIt client |
| #153 | `a45659a` | #101 | typescript-eslint ratchet: `no-unsafe-*` family + `no-explicit-any` + `no-unused-vars` from off → error in src across all 5 ESLint flat configs; tests retain off; `no-explicit-any` graduated with **zero src-side findings** |
| #154 | `6f2f353` | #109 | `apps/web/.eslintrc.cjs` → `eslint.config.mjs` via `@eslint/eslintrc` FlatCompat; `next lint` deprecation footgun gone |
| #156 | `cee8e5d` | #113 | `AuditService.recordWithin` docstring documents multi-strand semantics (per-tenant under `runInTenant` + global under super-admin/triggers); `audit-chain-integrity.e2e.test.ts` extended with per-tenant strand coverage |
| #157 | `b4e0e5e` | #63 PERF-04 | `ReservationService.createBasket` 5N+1 → 2N+5 queries via `findMany`-batched validation + `createManyAndReturn`; lock-hold-during-validation now O(1) round-trips |
| #158 | `959f2c6` | #64 PERF-02/07 | invitation list status filter pushed to WHERE clause; new `(tenantId, createdAt DESC)` index (migration 0019). data-architect EXPLAIN ANALYZE confirmed ~50× plan win (3393 buffers / 40 ms → 39 buffers / 0.76 ms). tech-lead found 2 blockers (missing rls.sql + test gap on filtered arms) — both folded |
| #159 | `d86ab3e` | #96 (#97 deferred-pilot, #98 by-marker) | trigger digest reproducibility: `now()` → `date_trunc('milliseconds', now())` so both `to_char(MS)` and the `timestamp(3)` column see the same ms value. Migration 0020 + chain_repair cutover marker. Pre-existing rows internally consistent but verifier needs `(stored_ms, stored_ms - 1ms)` candidate pair |
| #160 | `8ed98c9` | #89, #90, #91 | OIDC bundle: DNS-label validation (regex + IP-literal exclusion) on `OIDC_GOOGLE_TRUSTED_HD_DOMAINS` with warn-at-boot; new `PanoramaAuditAction` typed registry; symmetric `panorama.auth.oidc_login` success audit. security-reviewer APPROVE-WITH-NITS, all 4 JSDoc/comment nits folded |
| #161 | `136a914` | #59, #61 | `NotificationEventInput.eventType` typed to `NotificationEventType` (compile-time check); plugin-sdk `PanoramaEventName` derived from `PANORAMA_EVENT_NAMES` const, dropped 4 ghost events + 1 audit-only; new sync test asserts plugin-sdk ↔ runtime registry alignment |
| #162 | `deda331` | #123 (pino 10 row) | `pino` 9 → 10 in `@panorama/migrator`; dropped unused `pino` dep from core-api |
| #163 | `e78251e` | #123 (TS6 prep) | clears the 3 pre-existing CJS/ESM typecheck errors; drops `"type": "module"` from `@panorama/shared` + `@panorama/migrator` (tsconfig comments already documented intent); `tsc` → `tsc -b` in package build scripts (composite-mode aware); `with { 'resolution-mode': 'import' }` on the file-type type-import. **Unblocks the TS6 row.** |

## Issues formally closed in session 5

| Issue | Closed by |
|-------|-----------|
| **#34** SEC-02 — CSRF protection (doc-vs-code gap) | #151 |
| **#36** SEC-04 — Trivy double-bypass | already implemented in #68; closed by hygiene comment |
| **#39** ARCH-05 — lint echo-stubs | #152 |
| **#44** UX-master — trilingual promise | #147 + #148 (with #149 lock-in via JSX gate) |
| **#59** NOTIF-02 — plugin-sdk hand-maintained ghost events | #161 |
| **#61** NOTIF-07 — `enqueueWithin.eventType: string` | #161 |
| **#63** PERF-04 — basket 5N queries | #157 |
| **#64** PERF-02/07 — invitation list filter + index | #158 |
| **#89** — DNS-label validation on `OIDC_GOOGLE_TRUSTED_HD_DOMAINS` | #160 |
| **#90** — `panorama.auth.*` audit-action registry | #160 |
| **#91** — `panorama.auth.oidc_login` success audit | #160 |
| **#96** — trigger digest behavioural test (revealed reproducibility bug; fixed via migration 0020) | #159 |
| **#97** — canary-watch on `audit_events` tail SELECT contention | deferred — needs pilot tenant; documented Grafana query template + remediation paths |
| **#98** — structured `metadata.fixed_functions` marker | by #159's new chain_repair marker carrying the structured shape |
| **#101** — ts-eslint ratchet to error | #153 |
| **#109** — apps/web flat-config migration | #154 |
| **#113** — audit chain per-tenant under `panorama_app` | #156 (Option 1: documented multi-strand reality + per-tenant strand test) |

## Issues deferred with handoff comment (next-session pickup)

- **#92** OIDC integration test driving the controller end-to-end —
  M effort, needs stubbed-IdP (Express stub at `localhost:0` with
  `/.well-known/openid-configuration` + `/token` + `/jwks` + RSA-256
  keypair generated in beforeAll). Issue body lists the 5 cases.
- **#60** NOTIF-04 schema-registry expansion — content-expansion
  task: damage alerts / invitation bounces / reservation reminders /
  SLA escalation / ADR-0016 maintenance events. Each new schema
  is its own design decision (payload shape + handler chain).

## Pre-pilot ship-blocker UI gap list

Still **empty** (was empty at session-4 end, remained empty
throughout session 5). All PILOT-\* items closed in session 4.

## Test baseline (after session 5)

- Backend: **408/408** tests pass (was 370 at session 4 start;
  +38 net across the session)
- Web: typecheck / lint / build all clean
- core-api typecheck: **0 errors** (was 3 pre-existing CJS/ESM since
  0.3 prep — cleared by #163)
- i18n parity: **560 keys/locale** EN/PT-BR/ES (was 372 at
  session-4 end; +188 net)
- runAsSuperAdmin allowlist: 29 calls / 12 files (unchanged)
- ESLint flat configs: 7/7 packages green; `no-unsafe-*` family +
  `no-explicit-any` + `no-unused-vars` all at `error` in src across
  core-api + workspace packages (test files retain off for partial-
  mock fixtures)
- New CI gates added in session 5:
  - `pnpm i18n:jsx-gate` — TypeScript-AST scan rejecting JSXText
    ≥ 2 letter-words outside the allowlist
  - lint job pre-builds workspace packages so type-aware ESLint
    can resolve cross-package types
- Migrations through **0020**:
  - 0019 — invitation `(tenantId, createdAt DESC)` index
  - 0020 — audit trigger digest ms-truncate

## State of the open audit registry

**~13 issues open** as of session-5 end (was 30 at session-4 end —
**17 closed in session 5**).

### Bucket — UX / web debt (steady state)

- **#45** broader nav/UX overhaul — pilot-minimal subset closed
  in #142 + #154; parent issue still tracks dropdown menus,
  responsive sidebar, notification bell, keyboard shortcuts, search
- **#47** OPS-03 checkout form — two-field dropdown is too thin
- **#52** PROD-12 — broader "web UI ~10% complete" — needs
  re-scope after 0.3 surface additions
- **#101 follow-up** — apps/web `no-unsafe-*` ratchet

### Bucket — observability (carry-over from session 4)

- **`MaintenanceTicketSubscriber` audit-on-throw** — closed by #150
- **`MaintenanceSweepService` dedup-release warn** — closed by #150
- **Chain-integrity test for batched `audit.recordWithin`** — closed
  by #150 (5-row batch + cross-batch coherence) + extended by #156
  for per-tenant strand
- **#48 OPS-04 friction** — UI surface for
  `panorama.maintenance.auto_suggest_skipped` audits as "additional
  reports" on existing-ticket detail page (carry-over)
- **`actorUserId=null` audit rendering** — UI cleanup (carry-over)

### Bucket — Wave-2 / Wave-3 medium (queued)

- **#38** zero unit tests on web — broad backstop task
- **#50** PROD-08 bus factor — process item
- **#53** Wave-1 medium/low rollup
- **#60** NOTIF-04 schema content (deferred this session)
- **#92** OIDC integration test (deferred this session)
- **#123** deps majors umbrella — TS6 row now unblocked; NestJS
  11, Prisma 7, Vitest 4, zod 4 still M-effort each
- **#34 follow-up** — full double-submit CSRF (queued in the
  issue body of #34 itself)

### Bucket — Enterprise edition slices (deferred per ADR splits)

(Unchanged from session 4.)

- ADR-0016 §7 `MaintenanceEmailChannel` for `next_service_due`
- ADR-0009 + ADR-0011 maintenance email channels
- Per-tenant `notifyLastRequesterOnMaintenanceOpen` UI
- Email-channel for `panorama.reservation.flagged_overdue` /
  `no_show` audit rows from #141

## Decisions for next session

The session-4 handoff's "next-session ranking" is now exhausted.
Reranked for session 6:

### 1. **TypeScript 6 bump** (TOP — newly unblocked)

Now that `tsc --noEmit` is clean (#163), the TS6 row of #123 is the
natural next bump. M effort, broad surface (Prisma client types,
NestJS decorator emit, all DTOs). The base tsconfig's strict-mode
options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
may surface a new class of errors under TS 6.

### 2. **NestJS 11 + Prisma 7 bundle**

HIGH risk, M each per the umbrella. Both are framework-level; each
affects the other's compile surface, so single PR. Express v5 peer
change for Nest 11; ESM/CJS shifts for Prisma 7. Reviewer-mandatory
(security-reviewer for auth surface, data-architect for Prisma).

### 3. **Vitest 4 + zod 4 + openid-client 6**

Test + validation tooling. Vitest 4 changes coverage-provider
contract; zod 4 changes `.parse` semantics + transforms;
openid-client 6 changes Issuer factory. Each its own PR.

### 4. **#92 OIDC integration test**

M effort, single coherent PR. The deferred handoff comment lists
the 5 cases + the stubbed-IdP infrastructure shape.

### 5. **Soft items + content tasks**

#60 NOTIF schema expansion + #50 bus factor + #38 zero unit tests
+ #53 Wave-1 rollup. These are content / process work, scoped per
domain.

If forced to rank by code-work-value: **(1) → (4) → (3) → (2)**.
Bumping TS first surfaces regressions in subsequent bumps; the
OIDC e2e test gives more confidence before touching auth bumps;
Vitest/zod/openid-client are independent of the framework bumps;
NestJS 11 + Prisma 7 last because they're the riskiest.

## Working tree state at handoff

- Branch: `main`, up to date with `origin/main`
- HEAD: `e78251e` (after #163 merge)
- No uncommitted changes (only `.claude/projects/` +
  `.claude/scheduled_tasks.lock` untracked, gitignored)
- All session-5 branches deleted post-merge
- Tags unchanged from session 4: `pre-next15`

## Known caveats

1. **#97 canary watch is intentionally open / deferred** until the
   first pilot tenant onboards. Hand-off comment on the issue
   includes the Grafana query template + remediation paths.

2. **`FEATURE_MAINTENANCE` defaults to `false`** in
   `apps/core-api/.env.example`. Per-tenant flip stays the canary
   contract.

3. **`autoOpenMaintenanceFromInspection` defaults to `false`** per
   tenant. Auto-suggest doesn't fire until a tenant opts in via
   DB SQL or the (yet-to-be-built) Enterprise admin UI.

4. **Per-trigger UNIQUE indexes (migration 0016) collapse** the
   same-reservation multi-FAIL case to one ticket. Persona-fleet-
   ops semantic, documented in ADR-0016 v3 §5.

5. **Migration 0019** added `(tenantId, createdAt DESC)` on
   invitations — ~50× plan win on the admin list endpoint.

6. **Migration 0020** fixed audit-trigger digest reproducibility.
   Pre-0020 rows can be verified by the verifier-tooling-of-the-
   future trying both `(stored_ms, stored_ms - 1ms)` candidates;
   from 0020 onward, the stored value is sufficient.

7. **Locale resolution precedence** unchanged from session 4
   (cookie → Accept-Language → 'en'). Authenticated pages still
   prefer `loadMessages(membership.tenantLocale)`.

8. **`@panorama/shared` + `@panorama/migrator` are now CJS** (per
   #163; the package-json `type` field was inconsistent with the
   tsconfig's intent). Workspace consumers `require()` cleanly;
   apps/web (ESM via Next.js) consumes via Node's CJS-ESM interop
   for named imports.

9. **Workspace package builds use `tsc -b`** (#163). `tsc` alone
   was a silent no-op under composite mode — earlier builds
   appeared to work because dist artifacts persisted from prior
   runs.

10. **CI lint job pre-builds workspace packages** (#152) so
    type-aware ESLint can resolve cross-package types via
    `dist/**/*.d.ts`. Without the pre-build, `recommendedTypeChecked`
    falls back to `any` and the no-unsafe-* family fires on every
    `@panorama/shared` import.

## Auto-memory pointers

- `MEMORY.md` index — updated post-session-5 (16 PRs / 17 issues
  closed line)
- `feedback_dont_leave_local.md` — used 16× in session 5; standing
  authorization continues
- `feedback_no_coauthor_trailer.md` — `Assisted-By:` trailer
  verified across all 16 PRs
- `feedback_adr_review_cadence.md` — exercised on #151 (CSRF) and
  #158 (invitation perf); pattern continues to land

## Quick orient for the next session

- **TOP TASK**: TypeScript 6 bump (#123 row). Now unblocked by
  #163. M effort. Read the v6 changelog, run typecheck against
  the strict-mode options, expect a new class of errors around
  exactOptionalPropertyTypes. data-architect review needed if
  Prisma client typings shift; security-reviewer if auth surface
  is touched (unlikely for a TS-only bump).

- **Tests**: `pnpm --filter @panorama/core-api test` (408 pass);
  `pnpm --filter @panorama/web {typecheck,lint,build}` from repo
  root. i18n gates: `pnpm i18n:check && pnpm i18n:jsx-gate`.

- **Dev stack**: Docker (`docker_postgres_1`, `docker_redis_1`,
  `docker_minio_1`, `docker_mailhog_1`). Migrations through 0020
  applied locally.

- **Workspace package builds**: `pnpm --filter '!@panorama/core-api'
  --filter '!@panorama/web' build` produces `dist/**/*.{js,d.ts}`.
  Run this after a fresh checkout before any tsc / lint / vitest.

- ESLint configs are flat (`eslint.config.mjs`) across core-api +
  4 workspace packages + web. The per-package `no-unused-vars`
  config respects `^_`-prefix.

- Audit-action registry at
  `apps/core-api/src/modules/audit/audit-actions.ts` —
  `panorama.auth.*` only seeded; expand as you touch new audit
  actions.

— end of session-5 handoff —
