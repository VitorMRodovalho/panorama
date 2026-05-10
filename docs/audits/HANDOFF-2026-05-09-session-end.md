# Handoff — 2026-05-09 (deps sweep + Supabase staging + OIDC e2e)

Continuation of `HANDOFF-2026-04-27-session-5.md`. This session closed
**16 PRs across three thematic clusters** — full dependency sweep,
Supabase staging stand-up + workload smoke, and OIDC end-to-end test
coverage — and frames the next session as a **wave-based pickup of the
post-deps backlog** (CI hardening → backend bug → web UX foundation →
web feature surface → canary activation).

---

## Session 2026-05-09 — what landed (16 merged PRs + 7 issues closed)

### Cluster 1 — dependency sweep (closes most of #123)

| PR | Bump | Notes |
|----|------|-------|
| #168 | safe patch/minor — 13 packages | casl, swc, nestjs-i18n, nodemailer, react/react-dom 19.2.5→6, turbo, typescript-eslint, vue, aws-sdk, bullmq, next-intl |
| #170 | `@types/node` ^20→^22 across all workspaces | Sync to engine cap (project requires Node 22.11+) |
| #171 | `openid-client` 5 → 6 | Full OidcService rewrite; ESM dynamic-import shim mirroring #163's file-type pattern |
| #173 | ui-kit React 18→19 (peer + dev deps) | Closes the latent two-React-types problem |
| #174 | `zod` 3 → 4 | All 45 `z.string().uuid()` → `z.guid()` (preserves v3 permissive semantics for legacy UUIDs); `z.record(K,V)` 2-arg form |
| #175 | `vitest` 2 → **3** | held@3 — VitePress 1 pins Vite 5; #176 tracks 3→4 once VitePress 2 stable |
| #177 | `prisma` 5 → **6** | held@6 — v7 mandates ESM client + adapter; #178 tracks the architectural refactor |
| #179 | NestJS 10 → 11 family + swagger 7→11 + config 3→4 | Cleared the long-standing class-validator peer warning |
| #180 | `next` 15 → 16 + eslint-config-next 15 → 16 | held ESLint at 9 — eslint-plugin-react 7.37.5 breaks on ESLint 10 rule API; #181 tracks |

### Cluster 2 — post-Next-16 + post-OIDC-v6 hardening

| PR | Scope | Notes |
|----|-------|-------|
| #182 | Next 16 boot warnings | `serverActions` config moved back under `experimental` (Next 16 reverted Next 15's hoist); `middleware.ts` → `proxy.ts` rename |
| #183 | OIDC v6 hardening (closes #172) | 4 follow-ups: real callbackUrl forwards `iss` (RFC 9207); empty-state guard at service boundary; log redaction (code/state + ANSI strip); IdP `?error=` surfaced in controller. 4 rounds of CI to satisfy CodeQL `js/user-controlled-bypass` — final shape pulls session destroy out of the user-input branch entirely |

### Cluster 3 — Supabase staging stand-up + workload smoke

| PR | Scope | Notes |
|----|-------|-------|
| #184 | `scripts/setup-staging-env.sh` | Interactive bootstrapper for `apps/core-api/.env.staging`. Hidden input, psql probe, mode 600 |
| #185 | Migrations + bootstrap portable for managed PG | Migration 0011 `current_database()` parametric; new `prisma/supabase-bootstrap.sql` (idempotent role + extensions); `apply-migrations.sh` runs bootstrap automatically |
| #186 | Managed-PG migration workflow + runbook refresh | `DATABASE_DIRECT_URL` env-var slot for prisma migrate deploy (pgBouncer breaks Prisma sessions); runbook Step 1+3 collapsed to script invocations |
| #188 | `apps/core-api/scripts/smoke-staging-seed.ts` | Promoted from /tmp; idempotent additive seed pattern reusable for canary onboarding |
| #189 | `AuthIdentity.subject` schema-comment fix (closes #187) | Comment said `userId`; code uses `email`. 4 code sites + 2 tests confirm the convention |
| #190 | OIDC end-to-end test (closes #92) | In-process stub IdP + RS256-signed id_token; full Auth Code Flow happy path validated; +`OIDC_GOOGLE_ISSUER` + `OIDC_ALLOW_INSECURE_ISSUER` env-gated overrides |

### Issues closed (7 total)

- **#172** OIDC v6 hardening — closed by #183
- **#187** AuthIdentity schema comment — closed by #189
- **#92** OIDC e2e test — closed by #190
- **#59** NOTIF-02 plugin SDK ghosts — closed in #161 (stale — separator was `+` not `Closes`)
- **#61** NOTIF-07 enqueue eventType compile-time — closed in #161 (same)
- **#89** OIDC TRUSTED_HD_DOMAINS validation — closed in #160 (separator was `/`)
- **#90** `panorama.auth.*` audit-action registry — closed in #160 (same)
- **#91** OIDC login success audit — closed in #160 (same)

### Follow-up issues filed (4 still open, all gated externally or design-stage)

- **#176** vitest 3 → 4 — blocked on VitePress 2 stable
- **#178** Prisma 6 → 7 architectural — half-day work, no functional gain; reactive
- **#181** ESLint 9 → 10 — blocked on eslint-plugin-react adopting ESLint 10 rule API

---

## Strategic state at session end

| concern | state |
|---|---|
| Backend dep currency | All majors landed except 4 documented holds (vitest, prisma, eslint, throttler); all stable lines |
| Supabase staging | Schema migrations + RLS applied (20/20 + 17/17); roles created; smoke tenant + user + asset persists; OIDC + reservation create + audit chain all proven via real workload |
| Self-hosted | Unchanged + still works (idempotent guards, `DATABASE_DIRECT_URL` optional) |
| OIDC | v6 migrated, hardened, **and** end-to-end tested against stub IdP — risk surface for managed-IdP integration is now low |
| Tests | 418/418 core-api (was 408 at session start); +1 OIDC e2e + +9 OIDC validation unit tests |
| CI | All gates pass; CodeQL scanning enforced (one round was needed on PR #183) |
| Web | Next 16 + Turbopack default; all routes emit; functionally unchanged from session start |
| Canary | **HELD on user decision** — needs tenant choice + observation window |

---

## Wave plan for next session

The remaining open issues cluster into **four waves**, sequenced from low risk + small scope at the front to bigger touch surfaces at the back. Each wave **starts with a multi-agent risk + opportunity scan** before any code lands, mirroring the cadence proven in the `feedback_adr_review_cadence.md` memory pattern.

### Wave A — CI hardening + backend bug fix (~3-5h, 2 PRs)

**Pickups (in order):**
1. **#49** `ensure-community-complete` CI is grep, not functional. Replace with bootstrap-without-Enterprise-flags + exercise community paths + assert. Hardens the Community/Enterprise edition gate so Enterprise leaks into Community can't slip past CI.
2. **#48** OPS-04 damage flag at checkin doesn't auto-open a maintenance ticket. Asset goes to limbo. Real product bug. Extend `MaintenanceTicketSubscriber` (already listens to inspection failures per ADR-0016 §5) to also listen to `panorama.reservation.checked_in` events with `damageFlag = true`.

**Why first:** CI improvement is small + isolated + makes every subsequent wave safer to merge. Damage-flag bug is a real regression that breaks the ops loop the next waves are trying to make navigable.

**Pre-coding agent scan (single message, parallel):**
- `tech-lead` — verify the existing subscriber pattern can absorb the new event-type without coupling concerns
- `data-architect` — confirm no schema change needed; if any (e.g., new audit action), validate the migration path
- `security-reviewer` — confirm the auto-open path doesn't leak across tenants (subscriber must respect `tenantId` scope)
- `persona-fleet-ops` — does the ops user actually want auto-open here? Could it create ticket-flood under heavy fleet usage?

**Acceptance:** both PRs merged, 418→420 tests, no CI regression on staging smoke.

### Wave B — Web UX foundation (~6-10h, 3-4 PRs)

**Pickups (in order):**
1. **#38** ARCH-04 / PROD-07 — zero unit tests on web. Stand up vitest + RTL for `apps/web`; one trivial test as smoke. Non-negotiable foundation; everything in wave C-D depends on this being in place.
2. **#45** UX-nav — global navigation primitive + page header on calendar + every-page top bar. Isolates layout work from per-page form work.

**Why second:** Wave C (#47 checkout form) and any future web work needs the nav scaffold + test infra. Doing them as foundation isolates the per-page changes that follow.

**Pre-coding agent scan:**
- `ux-critic` — review the proposed nav information architecture against actual ops flows
- `persona-fleet-ops` — what nav items matter? What's missing today that breaks the loop?
- `tech-lead` — vitest + RTL setup choice (browser mode? jsdom? happy-dom?) and tradeoffs given the existing core-api vitest setup
- `product-lead` — confirm the nav scope is the foundation, not creep into "redesign everything"

**Acceptance:** nav landed across every authenticated page; web has at least one passing test; CI runs web tests.

### Wave C — Web feature surface (~10-15h, 4-6 PRs)

**Pickups (in order, all from #52 PROD-12 tracking):**
1. **#47** OPS-03 checkout form expansion — compliance status, vehicle details, inspection link
2. Asset CRUD — currently absent
3. User management — currently absent
4. Blackout / maintenance UI — currently absent

**Why third:** This is the largest surface. Doing it after wave B means every page lands on the existing nav + has tests from day one. Doing it sequentially (one form at a time) keeps PR scope reviewable.

**Pre-coding agent scan (per pickup, not per wave):**
- `ux-critic` + `persona-fleet-ops` — usability critique on each new form before code
- `product-lead` — Community vs Enterprise edition placement of any new feature
- `tech-lead` — server action vs client component boundaries

**Acceptance:** each PR ships with tests + persona-fleet-ops sign-off + product-lead edition placement confirmed.

### Wave D — Canary activation (~2-4h code, days of observation)

**Pickups:**
1. Decide canary tenant + observation window (decision, not code)
2. Apply `FEATURE_INSPECTIONS=true` + `FEATURE_MAINTENANCE=true` to staging
3. Onboard the canary tenant via `smoke-staging-seed.ts` adapted shape
4. Observation period — define dashboards, alerts, success metrics
5. Promote (default-flip) or rollback decision

**Why last:** Needs waves A-C done so the canary tenant has a navigable + complete-enough surface to actually exercise. Otherwise canary "data" is just empty.

**Pre-decision agent scan:**
- `product-lead` — pilot tenant choice, observation criteria, edition placement reconfirmation
- `persona-fleet-ops` — daily usage assumptions; what would canary surface that internal smoke didn't?
- `data-architect` — observability gaps; can we actually see what's happening on staging?

**Acceptance:** explicit go/no-go decision recorded in an ADR amendment.

---

## Risk + opportunity mapping protocol (per wave)

Per `feedback_adr_review_cadence.md` (5-agents-in-parallel pattern) — at the **start of each wave**:

1. **Single message, multiple Agent calls in parallel** — invoke all relevant subagents (the per-wave list above) on the wave's scope.
2. Each agent returns blockers + concerns + opportunities.
3. Iterate via blocker deltas — apply surgical fixes that close v2 blockers; spawn a v3 only if v2 fixes don't fully close.
4. Begin code work.

**Don't** invoke subagents per PR — wave-level is the right granularity. PRs within a wave that touch new surfaces (e.g., security-reviewer for any new auth code, data-architect for any new migration) get their own per-PR agent call as before.

---

## Carried-over operational notes (do not lose)

### Connection-string contract on Supabase staging

`apps/core-api/.env.staging` (gitignored, mode 600 from `setup-staging-env.sh`) has three URLs:

```
DATABASE_URL              = pooler  (port 6543) — runtime app traffic
DATABASE_DIRECT_URL       = direct  (port 5432) — `prisma migrate deploy`
DATABASE_PRIVILEGED_URL   = direct  (port 5432) — rls.sql + supabase-bootstrap.sql
```

`DATABASE_DIRECT_URL` and `DATABASE_PRIVILEGED_URL` are the same value on Supabase — separated by intent in `apply-migrations.sh`'s contract.

### Schema-comment vs code-truth pattern

Hit twice in this session:
1. `AuthIdentity.subject` — comment said `userId`, code used `email` (fixed in #189)
2. Migration 0011 `GRANT CONNECT ON DATABASE panorama` — assumed self-hosted DB name (fixed in #185)

**Heuristic for next session:** when seeding or hand-writing SQL against a fresh Supabase, look up the **call-site code** (not the schema comment, not the migration text) to find what convention is actually in use. Tests are also a reliable mirror.

### CodeQL `js/user-controlled-bypass`

Surfaced on PR #183. The rule fires when user input gates ANY action in the branch — even logging or throwing. Resolution pattern: pull side effects OUT of the user-input branch; leave only computation + literal exception throw inside.

### Smoke sandbox in staging (do not delete)

Persists for canary onboarding reuse:

- tenant `smoke-test` (id `2c86133c-6af5-4096-b5ca-4202634cf027`)
- owner `smoke-owner@panorama.invalid` — password in operator's password manager
- 1 category + 1 model + 1 asset (`SMOKE-ASSET-001`)
- 1 reservation history (audit chain begins with 12+ rows)

---

## Numbers

- 16 merged PRs in one extended session (continuation across day)
- 7 issues closed (4 by today's PRs, 3 stale-but-actually-done backfilled)
- 4 follow-up issues filed (all ecosystem-gated)
- Tests: 408 → 418 (+10 net)
- Long-standing peer warning (`@nestjs/swagger 7 → mapped-types → class-validator`) cleared
- Long-standing OIDC e2e gap (called out in 2 prior PRs) closed
- Supabase staging: stood up + smoke-tested + sandbox-tenant persists
