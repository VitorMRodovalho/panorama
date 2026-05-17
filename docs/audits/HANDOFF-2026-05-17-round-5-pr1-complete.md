# Handoff — 2026-05-17 (Round 5 PR1 complete)

> Continuation of `HANDOFF-2026-05-17-round-4-complete.md`. Round 5
> PR1 of the 7-round revised plan from `HANDOFF-2026-05-16-wave0-scan.md`
> is now complete. Closes the hard-prerequisite item (#49 functional
> CI gate) from Wave 0 acceptance §6. Round 5 has two further items
> in scope (observability + SESSION_SECRET rotation) before Round 5
> can be marked DONE.

## TL;DR

- **1 PR merged on 2026-05-17 (third session of the day)** — PR
  #223, commit `72a48c7`. Closes #49.
- The `ensure-community-complete` CI job — long misnamed as
  asserting "the Community test suite passes without the Enterprise
  packages installed" while only running a regex scan — has been
  split into honest halves:
  - **`no-enterprise-imports`** static gate (renamed + scope-
    expanded script).
  - **`community-smoke.e2e.test.ts`** functional gate that walks the
    six "always complete" community flows as one user story plus
    blackout enforcement, cross-tenant RLS isolation, and a
    monotone-order check on the reservation lifecycle.
- `docs/en/feature-matrix.md` got a new "How CI proves this" table
  mapping every always-complete promise to the test that covers it
  — the audit artefact a procurement reviewer expects.
- Wave 0 acceptance item 6 closes; Round 5 PR2 (observability per
  ADR-0018) and Round 5 PR3 (`SESSION_SECRET` rotation per
  maintainer decision 2026-05-16) remain inside Round 5.
- Follow-up #224 filed for the `essentials:asset-by-tag` block once
  the QR-scan endpoint lands.

## PR in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 223 | `72a48c7` | Round 5 PR1 — no-enterprise-imports + community-smoke functional gate (#49) | 7 files changed, +819/-149. Static gate renamed `ensure-community-complete` → `no-enterprise-imports`; scan extensions extended to `.js/.mjs/.cjs/.yml/.yaml`; scan locations extended to repo-root `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` + `.github/`. New `apps/core-api/test/community-smoke.e2e.test.ts` (7 `essentials:*` it() blocks). `feature-matrix.md` "How CI proves this" subsection. `docs/audits/2026-04-23-wave-2.md` Wave 2d.D entry appended with supersession note. |

## Numbers

- Session length: same working day as Round 3 close + Round 4 close
  (2026-05-17 — the third bounded session of the day)
- PRs shipped: 1 (squash + `--admin` bypass — solo-repo branch
  protection)
- Tests added: 7 web-end-to-end `essentials:*` blocks; ~1.5s test
  time / ~8s wall on the dev stack
- Suite total — core-api: 495/495 (was 488/488 after Round 4; +7 new
  essentials cases)
- Lines of TypeScript added: ~660 (test file 573 + script script 195
  – old script 139 = +629 net; +remaining for docs)
- Lines of docs added: ~40 in feature-matrix.md (How CI proves this
  table + intro paragraph), ~3 in 2026-04-23-wave-2.md
- Agent scans: 5 pre-implementation + 5 per-PR = 10 agent passes; 1
  rev1 iteration on convergent blocker (csv-export terminal state)

## Decisions locked this round

1. **Static gate rename for honesty** — `ensure-community-complete`
   was actively misleading because `feature-matrix.md` referenced it
   as a functional assertion the script could not deliver. Renamed
   in this PR rather than deferred to the enterprise-repo PR because
   "living with a lie through Round 7's v2 6-agent scan" was the
   wrong trade per product-lead.
2. **Static gate scope expanded** — scan extensions added
   `.js/.mjs/.cjs/.yml/.yaml` (every config/build surface that
   could pull an enterprise package by name); scan locations added
   repo-root `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`
   + `.github/` tree (where a `pnpm.overrides` redirect or a workflow
   `pnpm add` would otherwise slip past). Per security-reviewer.
3. **Functional gate as a single user-story walk, not per-flow
   duplication** — the per-flow assertions already exist in sibling
   e2e files. The value `community-smoke.e2e.test.ts` adds is
   proving the *handoff* between flows: that the audit row written
   by check-in is visible to the audit query, that the maintenance
   ticket created from a damaged check-in references the same asset,
   that the export contains the reservation just created. Per tech-
   lead.
4. **No dedicated `community-functional` CI job today** — the
   existing `Unit tests` job already runs `community-smoke.e2e.test.ts`.
   A separate job would duplicate the test stack with no excluded
   packages to differentiate, since there are zero `@panorama/enterprise-*`
   packages in the repo (per ADR-0002 the private repo is gated on
   day-60 metrics). Add the dedicated job at the same PR as the
   first enterprise package.
5. **No runtime `require.cache` boot guard today** — YAGNI per
   security-reviewer + product-lead. Adding a guard that scans the
   runtime module graph for `@panorama/enterprise-*` paths is
   meaningful only when there ARE enterprise paths to find. Defer
   to the enterprise-repo PR; document the deferral inline in the
   script header so the next reviewer doesn't reintroduce it without
   cause.
6. **CSV export terminal-state assertion is tight, not tolerant** —
   pre-rev1 the test accepted `status ∈ {completed, failed}` + an
   `objectKey truthy` assertion that `markFailed` never satisfies.
   Convergent BLOCKER from tech-lead + data-architect: that masked
   real partial-failure regressions. Tightened to
   `expect(row.status).toBe('completed')` so a `failed` terminal
   state surfaces as a real failure with `row.failedReason` in the
   message.
7. **Audit-chain assertion is order-checked on the reservation
   lifecycle subset, presence-only elsewhere** — per data-architect
   per-PR scan. A regression that emits `reservation.checked_in`
   before `reservation.approved` would have passed the presence-
   only assertion. The monotone-subsequence check on
   `[created, approved, checked_out, checked_in]` is the cheap
   composition signal worth keeping.
8. **snipeit-compat shim omitted from the smoke** — per persona-
   fleet-ops: migration-week traffic, not Tuesday-morning ops.
   Including it would dilute the gate's signal. The shim is
   independently covered by `snipeit-compat-read.e2e.test.ts` +
   `snipeit-compat-auth.e2e.test.ts`.

## Iterative review pattern (10 agent passes this PR)

5 agents at the pre-implementation stage shaped the design:
- tech-lead: no-new-CI-job + skip runtime guard YAGNI + composition
  asserts in the smoke
- security-reviewer: scan-ext + repo-root file coverage + cross-
  tenant negative assertion
- data-architect: TenantExportService.runJob test seam + per-flow
  it() blocks + dual-client pattern
- product-lead: Flow→Test→CI table + doc-vs-reality framing for
  the renamed-but-not-yet-additive window
- persona-fleet-ops: blackout enforcement + cross-tenant
  isolation as non-negotiable; drop snipeit-compat from the story

5 agents at the per-PR stage caught one convergent BLOCKER + four
NON-BLOCKERs:
- tech-lead + data-architect (CONVERGENT BLOCKER): csv-export
  terminal-state assertion was buggy — `markFailed` never sets
  objectKey, so `['completed','failed']` + `objectKey truthy`
  silently flaked. Fixed in rev1.
- security-reviewer: cross-tenant test didn't hit `/reservations`
  list (only assets + maintenances). Added in rev1.
- data-architect: audit-chain assertion presence-only would miss
  out-of-order regressions. Order check added in rev1.
- product-lead: framing of static gate as "tripwire for additive
  contract" rather than "proves enterprise boundary works".
  Strengthened in rev1.
- persona-fleet-ops + security-reviewer + tech-lead NITs: header
  notes on FEATURE_* defaults, cascade-failure behaviour, and
  the runJob test seam being test-only. Added in rev1.

The 5+5 cadence with a single rev1 iteration to close the
convergent blocker continues to be the right shape. The CI-only
infra slice doesn't have a ux-critic / persona lane to defer; both
substantive reviewers (persona for ops scenarios; product for
positioning) had real BLOCKERs at pre-scan that the implementation
honoured. Keep the 5-agent cadence even on infra-only PRs.

## What's left

### Round 5 remaining (after this PR)

- **PR2 — Observability stack (ADR-0018)** — pino behind a
  `LoggerService` + Sentry opt-in via `SENTRY_DSN` +
  `RequestContextMiddleware` registered BEFORE `SessionMiddleware`
  + extend `TenantContext` ALS with the request id. Touchy
  middleware ordering; well-scoped. ~half-to-full day.
- **PR3 — `SESSION_SECRET` secondary-key support** — iron-session
  accepts an array (primary + secondary); flip-then-drop rotation
  procedure documented in `docs/runbooks/secrets-rotation.md`
  (which lands in Round 6, but the in-code config + the rotation
  recipe paragraph should land here). ~half-day per maintainer
  decision 2026-05-16.

Neither remaining Round 5 PR is itself a URL-flip blocker — Wave 0
acceptance §7 (observability shipped) is the only post-#49 Round 5
gate, and §7 names "pino + Sentry opt-in + request-id ALS" which
PR2 covers.

### Rounds 6-7 (unchanged)

#### Round 6 — runbooks

- `docs/runbooks/incident.md` (LGPD 72h ANPD clock + breach
  taxonomy)
- `docs/runbooks/restore.md` + restore drill executed once
- `docs/runbooks/secrets-rotation.md` using inventory from
  Round 1
- Register controlled domain + `.well-known/security.txt`

#### Round 7 — pre-launch + v2 scan + URL flip go/no-go

- Privacy + ToS at `apps/web/src/app/legal/*` (LGPD Art. 9)
- Status page (Upptime on GH Actions)
- SBOM CycloneDX + cosign sigstore keyless sign on release
- README "Backend: production-ready" softened
- Hosted-vs-self-host CTA tracking
- v2 6-agent scan on the closed-blocker delta
- URL flip go/no-go decision recorded as ADR-0014 amendment

## Follow-ups filed during Round 5 PR1

- **#224** — `essentials:asset-by-tag` block once the GET-by-tag
  asset endpoint lands. Persona-fleet-ops WORTH-DOING from the
  per-PR scan. Real ops at 5:30 AM scan a sticker; they don't
  scroll a list.

## Follow-ups deferred during Round 5 PR1 (not blockers)

- **Runtime `require.cache` boot guard for `@panorama/enterprise-*`**
  — add at the same PR as the first enterprise package, when there
  are concrete test cases to exercise it (per security-reviewer +
  product-lead). Documented inline in `scripts/no-enterprise-imports.ts`
  header.
- **Dedicated `community-functional` CI job** — add at the same PR
  as the first enterprise package, to give the gate a named slot
  with real exclusion behaviour (per tech-lead).
- **ADR-0002 "Enforcement" subsection pointing at both gates** —
  defer until the enterprise repo lands, when the gate has real
  teeth (per product-lead).
- **`dispatchEmail` overwriting `completed` → `failed` on email
  failure** (pre-existing in `tenant-export.service.ts` L141-155;
  surfaced by tech-lead per-PR scan as out-of-scope for this PR) —
  file a follow-up issue when the next observability PR lands; the
  ergonomics-of-the-status field improvement belongs with the
  logging refactor.
- **`feature-matrix.md` "How CI proves this" `Static gate` column
  becoming load-bearing** — the column currently reads "n/a (no
  enterprise surface)" everywhere; the intro paragraph documents
  why and asks future contributors not to delete the column as dead
  weight before the enterprise repo lands.

## How to pick up the next session

1. **Read this handoff first.** Then
   `HANDOFF-2026-05-17-round-4-complete.md` for the prior round;
   `HANDOFF-2026-05-16-wave0-scan.md` for the 7-round plan
   structure; `HANDOFF-2026-05-17-round-3-complete.md` for the
   Round 3 endpoint context.
2. **Start Round 5 PR2 from a fresh branch off main.** Observability
   per ADR-0018 — pino + Sentry opt-in + `RequestContextMiddleware`
   + TenantContext ALS extension. Verify `RequestContextMiddleware`
   registers BEFORE `SessionMiddleware` in `app.module.ts`
   `configure(consumer)` — the ordering is the load-bearing
   correctness property. Add a smoke test asserting a request hits
   a controller AND its log line carries the request id.
3. **Per-PR 5-agent scan stays mandatory.** Round 5 PR1 had real
   BLOCKERs from BOTH pre-scan and per-PR scan even on a CI-only
   infra slice. Don't skip the per-PR scan because the diff "looks
   small" — the csv-export terminal-state bug was exactly that
   shape.
4. **No new migrations from Round 5 PR1.** Schema unchanged this
   round.
5. **Branch protection still has zero required status checks.**
   The job rename in this PR was safe because of that; if future
   work wires required checks, the new `no-enterprise-imports` job
   name (NOT the old `ensure-community-complete`) is what to
   reference.
6. **`FEATURE_SELF_SERVE_SIGNUP` continues default off in prod.**
   The hosted URL flip is gated by ALL 10 Wave 0 acceptance
   criteria; this PR closed #6, leaving 4 still open (Round 5 §7
   observability + Rounds 6 + 7).

## Files newly authoritative in main

- `scripts/no-enterprise-imports.ts` (renamed + scope-expanded)
- `apps/core-api/test/community-smoke.e2e.test.ts` (new — 573 lines)
- `docs/en/feature-matrix.md` §"How CI proves this" subsection
- `package.json` `check:no-enterprise-imports` npm script (was
  `ensure:community-complete`)
- `.github/workflows/ci.yml` `no-enterprise-imports` job (was
  `ensure-community-complete`)
- `docs/audits/2026-04-23-wave-2.md` Wave 2d.D entry appended with
  supersession note

## Risks / known-stale items

1. **`FEATURE_SELF_SERVE_SIGNUP=false` remains the only gate
   stopping public access today.** Round 5 PR1 doesn't change this.
   Discipline: do NOT flip the flag until URL-flip acceptance
   criteria close (Round 7 §"Wave 0 acceptance" 10/10).
2. **`S3_*` env vars remain REQUIRED on every deployment** per
   Round 3 PR #216's ObjectStorageModule hoist. Unchanged.
3. **The functional gate's per-PR cost is ~8s wall** (~1.5s test
   time + ~6s setup/teardown). Acceptable for a daily-driver gate;
   if it grows past 30s, consider tagging into a separate `vitest
   --testNamePattern 'essentials:'` step that runs ahead of the
   full suite for fail-fast.
4. **The csv-export essentials block uses real MinIO** (the sibling
   `tenant-export.e2e.test.ts` mocks `ObjectStorageService` for
   speed). If MinIO becomes unreliable in CI, the test's tight
   `expect(row.status).toBe('completed')` assertion surfaces as a
   regression — diagnose the infra, don't loosen the assertion.
5. **Stack depth.** This was the third bounded session of 2026-05-17
   (Round 3 close + Round 4 close + Round 5 PR1 + handoff). One
   well-scanned PR per session continues to be a sustainable
   cadence; trying to land all of Round 5 in one session would
   compress the per-PR scan iteration into noise.
6. **CSV export's `dispatchEmail` overwriting completed→failed on
   email failure is a real ergonomics bug in
   `tenant-export.service.ts` L141-155** that this PR explicitly
   declined to fix in scope (surfaced by tech-lead per-PR scan; out
   of scope for the gate PR). File before Round 5 PR2 lands so the
   logger refactor doesn't shadow it.

## Round-by-round status snapshot

| Round | Status |
|---|---|
| 0 — ADR scaffolding | DONE (#199) |
| 1 — Docs + a11y quick wins | DONE (#203) |
| 2A — Throttler wiring | DONE (#204 + #205) |
| 2B — Audit chain reproducibility | DONE (#206) |
| 3 prereqs — audit registry + env + throttler infra | DONE (#208 + #209 + #210) |
| 3 main — signup + verify + delete + export endpoints | DONE (#212 + #213 + #214 + #215 + #216) |
| 4 — daily-driver UX (vitest + shell + actor-on-row + approvals + settings) | DONE (#217 + #218 + #219 + #220 + #221) |
| **5 PR1 — no-enterprise-imports + community-smoke functional gate (#49)** | **DONE (#223)** |
| 5 PR2 — observability stack (ADR-0018) | NEXT |
| 5 PR3 — SESSION_SECRET secondary-key rotation | NEXT (independent of PR2) |
| 6 — runbooks (incident + restore drill + secrets-rotation) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

Wave 0 acceptance progress: 6/10 criteria closed (ADRs §1, Round 1
§2, Round 2 §3, Round 3 §4, Round 4 §5, **Round 5 PR1 §6**). 4 still
open: §7 observability (Round 5 PR2), §8 runbooks + restore drill
(Round 6), §9 Privacy/ToS/status/SBOM (Round 7), §10 v2 6-agent
scan (Round 7). The hosted URL flips when all 10 close.
