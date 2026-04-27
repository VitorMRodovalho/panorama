# Audit Resolution Handoff — 2026-04-26 (session 3)

Continuation of `HANDOFF-2026-04-26-bucket-d.md`. Session 3 closed
Sprint 1 + Sprint 2 of the audit-resolution plan and shipped the
backend MVP + web slice for the maintenance domain.

## Session 2026-04-26 (session 3) — what landed (13 merged PRs)

| PR | Issues / Scope | Notes |
|----|----------------|-------|
| #124 | #93 CI hardening | Added MinIO + MailHog service containers, workspace build step, Trivy v0.36.0, RLS GUC diagnostic — first-time-green CI in a week |
| #125 | #85 + #86 + #87 governance | ADR-0017 Accepted, `dev-environment-ai-tooling.md` runbook with Supabase MCP `0.7.0` pin, ai-architect non-negotiables 7 + 8 |
| #126 | #51 README | Aligned with reality, dropped overpromise; Shipped/Building/Planned status table |
| #127 | #84 plugin-sdk strip-back | Removed `onEvent` + `PluginModule.register()`; ADR-0006 Draft → Accepted (narrow scope) |
| #128 | (bonus) docs site fix | Wrapped unfenced `/maintenance/<id>` in backticks; first-time green Docs site in 4+ days |
| #129 | #33 OPS-01 reject reason | RejectionDecisionSchema requires note; web confirm panels with required-checkbox forcing function; approvalNote callout |
| #130 | #46 UX-22 photo upload | XHR + progress + cancel + retry; new same-origin route handler; 18 i18n keys; full a11y rails |
| #131 | #32 + #31 OPS-02 / DATA-01 | Mileage required at checkout/checkin; Asset.lastReadMileage now written with monotonic guard |
| #132 | #74 PILOT-03 backend MVP | MaintenanceService + Controller (open/list/get/updateStatus); state machine; asset-status flip; FEATURE_MAINTENANCE flag |
| #133 | #115 RLS follow-up | tenantId threaded through invitation BullMQ payload; 3 worker callbacks migrated to runInTenant; allowlist budget 6 → 3 |
| #134 | #62 PERF-03 | InspectionService.respond batch upsert (N→1 round-trip via Prisma.sql + ON CONFLICT DO UPDATE); dedupe by snapshotItemId |
| #135 | #120 sharp bump | sharp 0.33 → 0.34.5 + whitelist `autoOrient` pixel-property |
| #136 | #74 web slice | `/maintenance` list + `/maintenance/[id]` detail; damage callout on reservations; admin CTA on assets |

### Closing comments on issues

- #97 (canary watch on audit_events tail SELECT contention) — annotated
  to clarify it's not closeable pre-pilot; stays open as a tracked
  observability item with the Grafana query + 3 mitigation paths cited.
- #74 (PILOT-03) — stays OPEN with a progress comment. Backend MVP
  + web slice merged; two slices remain (auto-suggest subscriber +
  PM-due cron). Each lands as a separate PR.

### Reviews log

- security-reviewer two-pass on #132 (maintenance backend): caught the
  assignee-promotion attack BLOCKER on pass 1 (driver A could open a
  ticket on their reservation electing driver B as assignee, then B
  closes it, bypassing the implicit "admin closes work the requester
  opened" rule). Pass 2 APPROVE after the service-layer
  `admin_role_required_for_assignee` guard + dedicated e2e.
- ux-critic two-pass on #130 (photo uploader): blockers on i18n-only
  literals + color-only error signal. Both addressed; pass 2 SHIPPABLE.
- ux-critic two-pass on #136 (maintenance web): must-fixes on type
  label i18n, fmtError translation, assetId pre-fill, button-weight
  uniformity. All four addressed pre-merge.
- persona-fleet-ops two-pass on #129 (reject reason): pass 1 BLOCKER
  on missing forcing-function for Approve panel; pass 2 SHIPPABLE
  after required `I have reviewed this reservation` checkbox added.
- data-architect on #134 (respond batch): APPROVE after dedupe
  (cardinality_violation prevention) bundled in same PR.

## Test baseline (after session 3)

- Backend: **323/323** tests pass (was 311 at session start, +12 net
  across Sprint 1/2 work; #74 added 8, #62 added 1, #131 added 3).
- Web: typecheck / lint / build all clean.
- i18n: parity at **188 keys/locale** EN/PT-BR/ES (was 99 at the end of
  session 2; +89 net). Maintenance domain accounts for 64 of those.
- runAsSuperAdmin allowlist: 25 calls across 10 files (was 28/10
  before #133). Budget for `invitation.service.ts` is now 3 (was 6).

## State of the open audit registry

37 issues open as of session-3 end (was 61 at session 2 start). Bulk
of remaining items by category:

### Pilot blockers (still open)
- **#74** PILOT-03 maintenance — backend + web shipped; two slices
  remaining (auto-suggest + PM-due cron)
- **#75** PILOT-01 admin invitation-send UI
- **#76** PILOT-05 blackout management UI
- **#77** PILOT-04 overdue reservation sweep + UI
- **#78** PILOT-11 shared navigation shell

### UX/web debt
- #44 trilingual promise — ~80% strings still hardcoded English
  (session 3 chipped at this; +89 keys; still substantial work left)
- #45 no global navigation; assets dead-end (partially addressed by
  inline nav strips this session — proper extraction is #78)
- #47 OPS-03 checkout form; #48 OPS-04 damage flag → ticket (#48
  partially addressed by the damage callout in #136 but the dominant
  path needs the auto-suggest subscriber from #74)
- #52 PROD-12 web UI ~10% complete

### Architecture / governance
- #34 SEC-02 CSRF; #36 SEC-04 Trivy; #38 zero unit tests; #39 lint
  echo-stub; #50 PROD-08 bus factor; #53 Wave-1 medium/low rollup
- #59-61 NOTIF event catalog completion
- #63 PERF-04 basket 5N queries; #64 PERF-02/07 invitation list
- #113 audit chain per-tenant under panorama_app
- #123 deps majors umbrella

### Wave/audit follow-ups
- #89-92 OIDC follow-ups; #96-98 audit-trigger follow-ups (97 = canary
  watch); #101 typescript-eslint ratchet; #109 web flat ESLint

## Decisions needing maintainer input (Sprint 3+)

The following items are concrete and queue-ready but each represents
a meaningful direction call. Recommend the next session pick one or
two of these to scope rather than swing broadly:

1. **#75 PILOT-01 admin invitation-send UI.** Backend + email
   pipeline already shipped; only the admin-facing list + send + revoke
   surface is missing. Effort: M.
2. **#78 PILOT-11 shared navigation shell.** Pulled out of #136 as a
   real concern (4 pages with 3 nav styles). The current approach of
   inline `<nav>` strips on each page is acceptable for 0.3 but pilot
   day-2 will surface it. Effort: S-M for an extraction.
3. **#74 auto-suggest subscriber.** Closes the dominant path
   (≈70% of tickets per persona-fleet-ops) — driver checks in with
   damage flag → maintenance ticket auto-opens. Depends on **#40**
   (`panorama.reservation.checked_in_with_damage` event, currently
   missing). Effort: M (event + subscriber + e2e).
4. **#74 PM-due cron.** Distance-threshold predicate the ADR-0016 §9
   sweep depends on. Now unblocked since #31 closed. Effort: M.
5. **#77 PILOT-04 overdue reservation sweep + UI.** Persona-fleet-ops
   ranks this in the top 3 missing controls. Effort: M.
6. **#76 PILOT-05 blackout management UI.** Backend exists; only the
   web surface is missing. Effort: S-M.
7. **#44 trilingual migration.** Steady i18n work — moves the
   translated-coverage bar from ~30% (after this session's additions)
   toward the full ~80% gap. Long-tail; bite-size chunks per session.

If forced to rank, my recommendation: **(3) → (4) → (5)** in that
order, because (3) closes the persona-flagged dominant maintenance
path, (4) unlocks the PM-due cron that the entire mileage-required
chain (#32, #31) was set up to feed, and (5) is the highest-impact
operational surface still missing. Items (2) and (6) are smaller
and good companions; (1) is moderate and isolated; (7) is steady-pace.

## Working tree state at handoff

- Branch: `main`, up to date with `origin/main`.
- No uncommitted changes (the only untracked dir is `.claude/projects/`
  which is the harness's session-state, gitignored).
- All branches from session 3 deleted post-merge.
- Tags unchanged from session 2: `pre-next15` (rollback target for
  #110, kept around).

## Known caveats

1. **3 pre-existing typecheck CJS/ESM errors** in core-api:
   - `src/modules/import/import.service.ts:15` — `@panorama/shared` ESM
     under CJS
   - `src/modules/photo-pipeline/photo-pipeline.service.ts:10` —
     `file-type` type-only import needs `resolution-mode`
   - `test/import-roundtrip.e2e.test.ts:9` — `@panorama/migrator` ESM
     under CJS

   None block tests or builds. The fix is to either move core-api to
   `"type": "module"` (large blast radius) or convert the affected
   files to `.mts` (smaller). Recommend tackling before the TypeScript
   5 → 6 bump (#123 majors umbrella).

2. **#97 canary watch is intentionally open** until the first pilot
   tenant onboards. Don't try to close it pre-pilot.

3. **`FEATURE_MAINTENANCE` defaults to `false`** in
   `apps/core-api/.env.example`. Local dev `.env` (gitignored) sets it
   to `true` so smoke tests work; production / canary tenants flip on
   per-tenant when the auto-suggest + PM-due slices land.

4. **The maintenance web slice deep-links via `?assetId=X`.** The
   `MaintenanceTypes` array (9 entries) renders translated labels in
   the form `<select>` but submits the English machine value — API
   contract stays English. Don't add per-locale machine values.

5. **Cancel-reservations / inspection-tether tests** were updated to
   pass `mileage: 1000` after #131 made it required. If you add new
   reservation tests that check out / check in, mileage is mandatory.

## Auto-memory pointers for the next session

- `MEMORY.md` index lists the project memory files; the
  `project_session_2026_04_26_audit_resolution.md` file should be
  updated post-session-3 with the new totals (12 → 37 PRs cumulative
  this audit-resolution sprint; 24 → 49 closed issues; etc.). I'll
  refresh that memory pointer alongside this handoff.
- `feedback_dont_leave_local.md` — standing authorization for
  push+merge happy path, still in force.
- `feedback_no_coauthor_trailer.md` — `Assisted-By:` trailer, never
  `Co-Authored-By:`. Verified across all 13 PRs from this session.
- `feedback_adr_review_cadence.md` — parallel-agent ADR review pattern
  was used twice this session (security-reviewer on #132,
  ux-critic+persona-fleet-ops on #129/#130/#136).

## Quick orient for the next session

- Open `gh issue list --label audit:wave-1 --state open`,
  `--label audit:wave-2 --state open`,
  `--label audit:wave-3 --state open` to see remaining issues by wave.
- The PILOT-* labels mark the pre-pilot critical path; scope each
  Sprint by picking one or two from the ranked list above.
- Keep using the parallel-review pattern: spawn the relevant agent
  (security-reviewer for auth/tenant/mutation paths; data-architect
  for migrations/queries; ux-critic for web; persona-fleet-ops for
  ops-facing flows) in a single tool-uses block when work crosses
  domains; iterate to APPROVE before merging.
- Tests run via `pnpm --filter @panorama/core-api test` (323 pass) and
  `pnpm --filter @panorama/web {typecheck,lint,build}` from repo root.
  i18n parity gate: `pnpm i18n:check`.
- The dev stack is up — `docker_postgres_1`, `docker_redis_1`,
  `docker_minio_1`, `docker_mailhog_1` all running. No need to
  re-up infra for the next session.

— end of handoff —
