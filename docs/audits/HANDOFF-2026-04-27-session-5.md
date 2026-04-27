# Audit Resolution Handoff — 2026-04-27 (session 5)

Continuation of `HANDOFF-2026-04-27-session-4.md`. Session 5 closed
**all remaining sub-findings of #44** (the trilingual master finding)
across three PRs and added a CI gate to lock in the trilingual
invariant.

## Session 2026-04-27 (session 5) — what landed (3 merged PRs)

| PR | Issues / Scope | Notes |
|----|----------------|-------|
| #147 | #44 UX-05 | reservations/page.tsx + actions.ts trilingual; +96 keys/locale; `fmtError` → `fmtErrorKey`; locale-threaded `toLocaleString`; 12-template batch banner refactor (3 verbs × 4 conditions) |
| #148 | #44 UX-07/08/09/10 | inspections module + admin/inspection-templates trilingual (5 pages + 2 actions files); +89 keys/locale; new `maybeErrorItemsParam` helper carries pipe-joined item labels through `errorItems` URL param so `messages.t(...)` can substitute `{{items}}` at render time |
| #149 | #44 follow-up — CI gate | `scripts/i18n-jsx-gate.ts` walks every `.tsx` under `apps/web/src` with the TypeScript compiler API; fails CI on `JSXText` nodes with 2+ letter-word tokens not in allowlist or under `<code>`/`<pre>`/`<kbd>`/`<samp>` parents. Wired into the existing `i18n-coverage` CI job |

### Closing comments on issues

- **#44 (UX-master trilingual)** — sub-findings UX-01/02/03/04/05/06/07/
  08/09/10/30 partial/37 closed across PRs #145, #146, #147, #148.
  UX-11 (server-action error mapping) was the meta-pattern — applied
  uniformly across reservations, inspections, blackouts, invitations,
  inspection-templates actions files (5 of 5). The proposed CI grep
  gate landed via #149.

  Recommend **closing #44** once a reviewer confirms the punch list
  in `docs/audits/HANDOFF-2026-04-23.md` §UX-master is exhausted.

### Reviews log

All 3 PRs were push+merge per the standing direction
(`feedback_dont_leave_local.md`); CI gates (typecheck + lint + i18n
parity + JSX gate + allowlist + tests) carried the verification load.

- security-reviewer / tech-lead one-pass on **#147**: no review
  invoked (no auth-surface or migration touched; pure web text).
- security-reviewer / tech-lead one-pass on **#148**: no review
  invoked (same — no auth-surface, no migrations).
- one-pass on **#149**: no review invoked (CI tooling only;
  self-tested with a deliberately-bad fixture .tsx).

## Test baseline (after session 5)

- Backend: **370/370** tests pass (unchanged — session 5 was web/CI
  only).
- Web: typecheck / lint / build all clean.
- i18n parity: **560 keys/locale** EN/PT-BR/ES (was 372 at session 4
  end; +188 net across the session).
- runAsSuperAdmin allowlist: **29 calls across 12 files** (unchanged).
- New: **i18n JSX gate** runs in CI as a step inside the
  `i18n-coverage` job. Locally: `pnpm i18n:jsx-gate`.

## State of the open audit registry

**~30 issues open** as of session-5 end (was 30 at session-4 end —
session 5's PRs sub-resolve #44 without closing the issue itself).

**The pre-pilot ship-blocker UI gap list is still empty** (was empty
at session-4 end). The remaining queue continues to be steady-state
work: observability follow-ups, deferred edition-split features, and
the operational items that depend on a pilot tenant being chosen.

### Bucket — UX / web debt (steady state)

- **#44** UX-master trilingual — substantively closed by sessions 4+5;
  recommend formal close of the issue once a reviewer confirms.
- #45 — broader nav/UX overhaul; pilot-minimal subset closed in #142.
  Parent issue still tracks dropdown menus + responsive sidebar +
  notification bell + keyboard shortcuts + search.
- #47 OPS-03 checkout form — two-field dropdown is too thin; needs
  compliance status + vehicle details + inspection link. M effort.
- #52 PROD-12 — broader "web UI ~10% complete" parent. With sessions
  3+4+5's surface additions this is no longer ~10%. Worth re-scoping
  the issue body to reflect.

### Bucket — observability + soft follow-ups (carry-over from session 4)

(All low-to-medium priority.)

- **`MaintenanceTicketSubscriber` audit-on-throw** — immediate audit
  row on `asset_not_found` / `asset_cross_tenant` / `missing_tenant_id`
  throw paths. Same shape needed for `auto_suggest_skipped_flag_off`.
- **`MaintenanceSweepService` dedup-release warn** — promote
  `releaseDedup`'s `del`-returns-zero from debug to warn so a Redis
  partition during release surfaces in alerting.
- **Chain-integrity test for batched `audit.recordWithin`** — locks
  the invariant against a future Prisma upgrade that changes
  tx-client read-your-own-writes.
- **#97** canary-watch on `audit_events` tail SELECT contention.
- **#48 OPS-04 friction** — UI surface for
  `panorama.maintenance.auto_suggest_skipped` audits as "additional
  reports" on the existing ticket detail page.
- **`actorUserId=null` audit rendering** — render
  "system (on behalf of \<originalActorUserId\>)" on the maintenance
  detail page.

### Bucket — Wave-2 / Wave-3 medium-priority (queued but not blocking)

(Unchanged from session 4.)

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

(Unchanged from session 4.)

- ADR-0016 §7 `MaintenanceEmailChannel` for
  `panorama.maintenance.next_service_due` (gated on
  `EditionService.isEnterprise()`).
- ADR-0009 + ADR-0011 `MaintenanceEmailChannel` for the other
  maintenance events.
- Per-tenant `notifyLastRequesterOnMaintenanceOpen` UI surface.
- Email-channel for the new `panorama.reservation.flagged_overdue` /
  `panorama.reservation.no_show` audit rows from #141.

## Decisions needing maintainer input (session 6+)

The session-4 ranking of "(1) UX-05 → (3) CI grep gate → (2) UX-07-10
→ (4) soft observability" is now exhausted (items 1, 2, 3 all
shipped). Re-ranking for session 6:

### 1. **Soft observability follow-ups bundle** (TOP PRIORITY)

The 3 soft items from session-4 reviews (audit-on-throw +
dedup-release-warn + chain-integrity test) into one focused PR.
Effort: S-M.

### 2. **FEATURE_MAINTENANCE canary rollout**

Same shape as the FEATURE_INSPECTIONS canary plan. Pick one pilot
tenant, flip `autoOpenMaintenanceFromInspection = true`, watch for
7 d:

- `panorama.maintenance.next_service_due` audit volume
- `pm_due_circuit_breaker_fired` log line (planner regression)
- `pm_due_audit_batch_failed` log line (chain integrity)
- `panorama.maintenance.auto_suggest_skipped` audit volume

### 3. **Enterprise email-channel slices** (ADR-0009 / 0011 / 0016 §7)

Three email channels are deferred to Enterprise edition. Bundle into
one PR if Enterprise-edition wiring is ready, otherwise keep
deferred.

### 4. **Pilot tenant identification + onboarding**

Out-of-scope for code work but on the critical path for canary
rollouts.

### 5. **Issue hygiene**

Recommend formal close of #44 (UX-master trilingual) once a reviewer
confirms the page-level punch list is exhausted. #45 (broader
nav/UX) and #52 (PROD-12 web UI ~10%) need scope adjustments to
reflect what's actually shipped.

If forced to rank by code-work value: **(1) → (3) → (2)**.
Items 4 + 5 are dependency-bound or maintainer judgement.

## Working tree state at handoff

- Branch: `main`, up to date with `origin/main`.
- HEAD: `3010be6` (after merge of #149); session-5 PRs all squashed
  into main as #147 → `30ba913`, #148 → `7ababcd`, #149 → `3010be6`.
- No uncommitted changes (only `.claude/projects/` +
  `.claude/scheduled_tasks.lock` untracked, gitignored).
- All session-5 branches deleted post-merge.
- Tags unchanged from session 4: `pre-next15`.

## Known caveats

(All session-4 caveats still apply. New caveats from session 5:)

8. **i18n JSX gate is heuristic.** It only flags `JSXText` nodes;
   hardcoded `placeholder="..."`, `title="..."`, or `{'literal'}`
   inside JSX still pass. The codebase already routes those through
   `messages.t(...)`; widening the rule introduces more false
   positives than it catches. If a future regression exposes this
   blind spot, options are: (a) extend the gate to also walk
   `JsxAttribute` value initializers; (b) write a custom ESLint
   rule. Leave as-is until justified.

9. **i18n JSX gate allowlist is exact-match.** 5 visual separators
   currently (`—`, `→`, `←`, `...`, `…`). Each entry weakens the
   gate; add with intent.

## Auto-memory pointers for the next session

- `MEMORY.md` index — already updated post-session-5 to reference
  this handoff.
- `feedback_dont_leave_local.md` — standing authorization for
  push+merge happy path remains in force; used 3× in session 5.
- `feedback_no_coauthor_trailer.md` — `Assisted-By:` trailer
  verified across all 3 PRs from session 5.
- `feedback_adr_review_cadence.md` — not exercised in session 5
  (no ADR touched). Pattern remains the right shape for
  ADR-touching PRs.

## Quick orient for the next session

- **TOP TASK: soft observability bundle.** Three items from session-4
  reviews, all listed in `Bucket — observability + soft follow-ups`
  above. Effort: S-M.

- Open `gh issue list --label audit:wave-1 --state open` for
  remaining medium/low Wave-1 items if soft observability is too
  lightweight.

- Tests run via `pnpm --filter @panorama/core-api test` (370 pass)
  and `pnpm --filter @panorama/web {typecheck,lint,build}` from
  repo root. i18n gates: `pnpm i18n:check && pnpm i18n:jsx-gate`.

- The dev stack is up — `docker_postgres_1`, `docker_redis_1`,
  `docker_minio_1`, `docker_mailhog_1` all running (or whatever
  Docker named them).

- Migrations through 0018 already applied locally. No new migrations
  in session 5.

— end of handoff —
