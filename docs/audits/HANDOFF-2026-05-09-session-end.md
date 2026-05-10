# Handoff — 2026-05-09 (deps sweep + Supabase staging + OIDC e2e + public-preview pivot)

> **Revision history.** v1 of this doc (committed 2026-05-09T20:30) framed
> the next session as a four-wave pickup ending in canary activation. v2
> (this doc) incorporates a strategic re-anchor that landed late same-day:
> the project's gating customer (Amtrak/FDT) is no longer relevant —
> maintainer no longer works there. Re-evaluation by the 5-agent committee
> (tech-lead + data-architect + security-reviewer + product-lead +
> persona-fleet-ops, then a delta pass with ux-critic) converged on a
> **free hosted public-preview model** rather than a commercial launch.
> The wave plan now opens with a new **Wave 0 — public-preview readiness**
> that runs parallel to Wave A and gates the public hosted URL.

Continuation of `HANDOFF-2026-04-27-session-5.md`. This session closed
**17 PRs across three thematic clusters** — full dependency sweep,
Supabase staging stand-up + workload smoke, and OIDC end-to-end test
coverage — and frames the next session as a **wave-based pickup of the
post-deps backlog with Wave 0 sequencing the public-preview path**.

---

## Session 2026-05-09 — what landed (17 merged PRs + 8 issues closed)

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

### Cluster 3 — Supabase staging stand-up + workload smoke + OIDC e2e

| PR | Scope | Notes |
|----|-------|-------|
| #184 | `scripts/setup-staging-env.sh` | Interactive bootstrapper for `apps/core-api/.env.staging`. Hidden input, psql probe, mode 600 |
| #185 | Migrations + bootstrap portable for managed PG | Migration 0011 `current_database()` parametric; new `prisma/supabase-bootstrap.sql` (idempotent role + extensions); `apply-migrations.sh` runs bootstrap automatically |
| #186 | Managed-PG migration workflow + runbook refresh | `DATABASE_DIRECT_URL` env-var slot for prisma migrate deploy (pgBouncer breaks Prisma sessions); runbook Step 1+3 collapsed to script invocations |
| #188 | `apps/core-api/scripts/smoke-staging-seed.ts` | Promoted from /tmp; idempotent additive seed pattern reusable for canary onboarding |
| #189 | `AuthIdentity.subject` schema-comment fix (closes #187) | Comment said `userId`; code uses `email`. 4 code sites + 2 tests confirm the convention |
| #190 | OIDC end-to-end test (closes #92) | In-process stub IdP + RS256-signed id_token; full Auth Code Flow happy path validated; +`OIDC_GOOGLE_ISSUER` + `OIDC_ALLOW_INSECURE_ISSUER` env-gated overrides |
| #191 | Handoff doc v1 | Original 4-wave plan (superseded by this v2) |

### Issues closed (8 total)

- **#172** OIDC v6 hardening — closed by #183
- **#187** AuthIdentity schema comment — closed by #189
- **#92** OIDC e2e test — closed by #190
- **#59** NOTIF-02 plugin SDK ghosts — closed in #161 (stale — separator was `+` not `Closes`)
- **#61** NOTIF-07 enqueue eventType compile-time — closed in #161 (same)
- **#89** OIDC TRUSTED_HD_DOMAINS validation — closed in #160 (separator was `/`)
- **#90** `panorama.auth.*` audit-action registry — closed in #160 (same)
- **#91** OIDC login success audit — closed in #160 (same)

### Follow-up issues filed (3 still open, all gated externally)

- **#176** vitest 3 → 4 — blocked on VitePress 2 stable
- **#178** Prisma 6 → 7 architectural — half-day work, no functional gain; reactive
- **#181** ESLint 9 → 10 — blocked on eslint-plugin-react adopting ESLint 10 rule API

---

## Strategic re-anchor (the late-day pivot)

The original handoff treated the project's roadmap as gated by
Amtrak/FDT pilot acceptance. That was stale: the maintainer is no longer
employed there. **Panorama is now an independent open-source platform
with no specific anchor customer.**

### What this changes

- ADR-0013's "internal staging only / NOT customer-facing" framing was
  anchored on the Amtrak constraint. **It can be re-evaluated.**
- ADR-0014 (Cloud SKU) was deliberately unwritten because pricing without
  a customer is vanity. **It can be re-scoped from "Cloud SKU" to "Public
  hosted instance"** — same code path, different positioning, no billing.
- product-lead's 2026-04-19 "managed-cloud pre-SKU creates 3rd edition by
  accident against ADR-0002" concern only applies if you charge for the
  hosted instance. **A free hosted instance under AGPL is not a third
  edition; it's the Community edition deployed.**

### What this DOESN'T change

- The web UI gap (#52 — ~10% of feature surface) is functional, not
  commercial. persona-fleet-ops on this run: *"Money was never the
  blocker — the daily-driver gap was."*
- Backend production-readiness gaps (observability, runbooks, secret
  rotation) tech-lead flagged are real regardless of payment.
- LGPD applies to ANY user data, free or paid.

### Recommended positioning (per committee consensus)

**Free hosted public-preview alongside the AGPL self-host option.** Two
journeys, one homepage. Goal: get out of theory, collect real ops feedback,
test market-fit + demand signals organically. Self-host stays first-class
(AGPL fork-friendly with attribution).

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
| Public site | Live at panorama.vitormr.dev (GitHub Pages, served from `docs/`); content state intentionally pre-alpha; **Wave 0 will refresh with dual-narrative homepage** |
| Production-readiness | **GAPS** — no pino/Sentry/OTEL, no restore drill, no documented secret rotation, edition gate is grep |
| Public-preview readiness | **GAPS** — no Privacy/ToS, no incident runbook, no status page, audit chain trigger bug (#41), no `security@` on controlled domain |
| Canary | **HELD on user decision** — re-shaped: first design partners on the public preview ARE the canary |

---

## Wave plan for next session

The next session opens five tracks — Wave 0 + Waves A→D. Wave 0 is new
this revision and runs **parallel to Wave A**; the other waves keep the
original sequencing but Wave D is reshaped from "internal canary" to
"public-preview launch with first design partners as canary."

Each wave **starts with a multi-agent risk + opportunity scan** before any
code lands, mirroring the cadence proven in the
`feedback_adr_review_cadence.md` memory pattern.

### Wave 0 — Public-preview readiness (NEW; ~5-7d, parallel to Wave A)

**Gates the public hosted URL.** The framing flip itself (README +
in-repo positioning) does NOT need Wave 0 — it can land standalone any
time. Don't couple framing-decision date to launch-date.

**Pickups (committee consensus, all 4 of 4 in delta pass):**

1. **#41 audit-chain tamper trigger fix** — security-reviewer + data-architect both blockers. Audit chain is the trust core regardless of payment; SECURITY.md currently admits the trigger breaks the chain — that's a known-bug-in-the-trust-anchor.
2. **Privacy Policy + ToS plain-language** at `apps/web/src/app/legal/*` — LGPD Art. 9 mandatories: controller identity, DPO contact (`security@` on controlled domain), categories of data collected (email, tenant name, photos, GPS if any), purpose + legal basis (consent for early-access), retention promise, sub-processor list named (Supabase, S3 host, email provider), Art. 18 data-subject rights flow (access/rectify/delete via mailto). Plain language; lawyer review NOT required for v1 (defers to first paying tenant or >1k active users).
3. **Incident response runbook** at `docs/runbooks/incident.md` — 72h ANPD/DPA notification clock (statutory under LGPD, not contractual), comms template, who-does-what, breach scope criteria.
4. **Backup + restore drill** — execute once on staging, evidence + measured RTO/RPO documented at `docs/runbooks/restore.md`. Daily-only on Supabase Pro is ACCEPTABLE for free preview (defers PITR until first paying tenant).
5. **ROLLBACK.md backfill** for migrations 0013–0020 + drill one against `pg_dump` restore. (data-architect found the `every-migration-has-rollback` claim was false on disk — zero ROLLBACK.md files exist today.)
6. **Status page + `security@` on controlled domain** — Upptime on GH Actions free; replace temp `security@vitormr.dev` with stable address.
7. **Data-export + delete-my-tenant** documented + endpoint working. persona-fleet-ops: *"show export button BEFORE signup."*
8. **Rate-limit + signup abuse cutoff** verified fail-closed against synthetic flood test.
9. **SBOM published on releases** — CycloneDX from existing deps; ~1 day, signals seriousness for self-host evaluators too.
10. **Homepage rewrite** per ux-critic hypothesis (see "Public-site rewrite" section below) + drop "pre-alpha" framing.

**NOT in Wave 0 (deferred to first paying tenant or post-feedback signal):**
- Lawyer-reviewed Privacy / ToS (plain-language acceptable for v1)
- DPA template
- SOC2 scoping
- Pen-test
- Pricing decision
- ADR-0014 as "Cloud SKU" — instead, write as **"Public hosted instance"** ADR (drops billing/SLA, keeps tenancy + data lifecycle clauses)

**Pre-coding agent scan (single message, parallel):**
- `security-reviewer` — final pass on the Wave 0 stack as a unit (esp. #41 + Privacy + incident runbook + rate-limit cutoff)
- `data-architect` — restore-drill plan + ROLLBACK.md format + connection-limit math for horizontal scaling
- `tech-lead` — observability addition (pino + Sentry + request-id + tenant-tag in log context); per-tenant throttler config; secret-rotation runbook scope
- `ux-critic` — homepage rewrite + IA + status page placement

**Acceptance:**
- All 10 items committed + verified
- Public hosted URL opens with banner: "early access, no SLA, data may be wiped with 30-day notice"
- Sign-up flow exists with consent + Privacy link + delete-my-data path documented
- security-reviewer green-lights public URL release

### Wave A — CI hardening + backend bug fix (~3-5h, 2 PRs)

**Pickups (in order):**
1. **#49** `ensure-community-complete` CI is grep, not functional. Replace with bootstrap-without-Enterprise-flags + exercise community paths + assert. Hardens the Community/Enterprise edition gate so Enterprise leaks into Community can't slip past CI. tech-lead flagged this as a licensing-correctness blocker the moment money changes hands — also matters for "free hosted is genuinely Community" claim.
2. **#48** OPS-04 damage flag at checkin doesn't auto-open a maintenance ticket. Asset goes to limbo. Real product bug. persona-fleet-ops cites this twice across both reviews as a daily-driver blocker. Extend `MaintenanceTicketSubscriber` (already listens to inspection failures per ADR-0016 §5) to also listen to `panorama.reservation.checked_in` events with `damageFlag = true`.

**Why parallel to Wave 0:** CI improvement is small + isolated + makes every subsequent wave safer to merge. Damage-flag bug is a real regression that breaks the ops loop the next waves are trying to make navigable.

**Pre-coding agent scan:**
- `tech-lead` — verify the existing subscriber pattern can absorb the new event-type without coupling concerns
- `data-architect` — confirm no schema change needed
- `security-reviewer` — confirm the auto-open path doesn't leak across tenants
- `persona-fleet-ops` — does the ops user actually want auto-open? Could it create ticket-flood under heavy fleet usage?

**Acceptance:** both PRs merged, 418→420 tests, no CI regression on staging smoke.

### Wave B — Web UX foundation (~6-10h, 3-4 PRs)

**Pickups (in order):**
1. **#38** ARCH-04 / PROD-07 — zero unit tests on web. Stand up vitest + RTL for `apps/web`; one trivial test as smoke. Non-negotiable foundation; everything in wave C-D depends on this.
2. **#45** UX-nav — global navigation primitive + page header on calendar + every-page top bar.

**Why second:** Wave C (#47 checkout form) and any future web work needs the nav scaffold + test infra. Doing them as foundation isolates the per-page changes that follow.

**Critical signal from persona-fleet-ops delta pass:** *"Wave B+C is the cutover gate, not the signup gate."* This means once Wave 0 + Wave A close, **users CAN sign up to evaluate** in shadow/dual-entry mode — they don't have to wait for B+C. So Wave B starting in parallel with public-preview opening is fine.

**Pre-coding agent scan:**
- `ux-critic` — review the proposed nav information architecture against actual ops flows
- `persona-fleet-ops` — what nav items matter? What's missing today that breaks the loop?
- `tech-lead` — vitest + RTL setup choice (jsdom? happy-dom?) and tradeoffs given the existing core-api vitest setup
- `product-lead` — confirm the nav scope is the foundation, not creep into "redesign everything"

**Acceptance:** nav landed across every authenticated page; web has at least one passing test; CI runs web tests.

### Wave C — Web feature surface (~10-15h, 4-6 PRs)

**Pickups (in order, all from #52 PROD-12 tracking):**
1. **#47** OPS-03 checkout form expansion — compliance status, vehicle details, inspection link
2. Asset CRUD — currently absent
3. User management — currently absent
4. Blackout / maintenance UI — currently absent

**Why third:** This is the largest surface. Doing it after wave B means every page lands on the existing nav + has tests from day one. Doing it sequentially (one form at a time) keeps PR scope reviewable.

**persona-fleet-ops's "minimum daily-driver UI cut for FREE alpha" (relaxed from paid):**
- Approvals queue that survives two ops clicking at once (proven, not promised)
- Check-in/check-out flow end to end, even if photoless (with a banner saying "photos coming 0.3")
- Audit trail visible from the row, one click — non-negotiable
- Export-my-data button
- Skip for v1: maintenance ticket management UI (auto-open via Wave A #48; manage via email), reporting (CSV export OK), photo capture (roadmap 0.3)

**Pre-coding agent scan (per pickup, not per wave):**
- `ux-critic` + `persona-fleet-ops` — usability critique on each new form before code
- `product-lead` — Community vs Enterprise edition placement of any new feature
- `tech-lead` — server action vs client component boundaries

**Acceptance:** each PR ships with tests + persona-fleet-ops sign-off + product-lead edition placement confirmed.

### Wave D — Public-preview launch (reshaped — first design partners ARE the canary)

**Pickups:**
1. Open the hosted URL publicly (Wave 0 complete; framing flipped)
2. First 1-3 design partners onboarded via `smoke-staging-seed.ts` adapted shape — this REPLACES the old "internal canary" concept; the design partners ARE the canary
3. Observation period — instrument 3 metrics (per product-lead delta):
   - **Tenant 7-day retention** (logged in + did one write op week 2)
   - **Inbound feedback events / active tenant / week** (target ≥0.3; below = "users not partners")
   - **Self-host fork activations** (telemetry ping or docker-pull proxy) — tells you which journey resonates
4. After 30-60 days of public-preview signal: decide on `FEATURE_INSPECTIONS=true` + `FEATURE_MAINTENANCE=true` default-flip globally + write the ADR-0014 "Public hosted instance" amendment with what we learned

**Why this works as canary now:** The original "internal canary on Amtrak tenant" had no Amtrak. The free-hosted public-preview gives us real workload signal that internal smoke can't — at zero customer-acquisition cost.

**Pre-decision agent scan (post-observation):**
- `product-lead` — what the metrics actually told us; pricing/SKU readiness signal
- `persona-fleet-ops` — daily-driver feedback synthesis
- `data-architect` — observability + retention + scale signals from real usage

**Acceptance:** explicit go/no-go decision recorded in an ADR amendment; FEATURE_* default flipped (or held with reason).

---

## Public-site rewrite (Wave 0 deliverable)

ux-critic's hypothesis (per delta-pass review):

> **Panorama** — Run your IT assets and your operational fleet from one place.
>
> Open source (AGPL-3.0). Trilingual EN / PT-BR / ES. Self-host it, or use our hosted instance free while we build it with operators.
>
> Status: early access — real product, rough edges, weekly contact with the team.
>
> [Get a hosted account →]   [Self-host on GitHub →]

### IA priority order (top to bottom)

1. **Hero** (dual CTA + one-line value prop)
2. **Status + honesty band** — 2 columns, 4 bullets each: "what works" / "what's rough"
3. **Hosted-evaluator block** — how to sign up, data location, **how to export and leave**, support channel
4. **Self-host block** — GitHub link, AGPL one-liner, deploy guide link, contribution guide
5. **Trust strip** — status page, security contact, public roadmap, incident log
6. **Language switcher** — below the fold; flags-only above is noise

### Trust surfaces ranked by cost vs lift (cheapest first)

1. Public roadmap on GitHub Projects — already exists, just link it
2. `security.txt` + a real email — 30 minutes
3. Status page (Upptime on GH Actions, free) — ~1 day
4. Public incident log even if it's a CHANGELOG section — minutes
5. Data-export + account-delete documented BEFORE signup, not after — load-bearing trust signal

### Framing words — DROP "pre-alpha"

- **DROP**: "pre-alpha", "alpha", "beta" (each carries its own baggage)
- **AVOID**: "pilot" (implies paid follow-on)
- **USE**: "early access — free while we shape it with operators" OR "public preview"
- Pair with: "Bring real fleet data, expect rough edges, talk to us weekly."

---

## Risk + opportunity mapping protocol (per wave)

Per `feedback_adr_review_cadence.md` (5-agents-in-parallel pattern) — at the **start of each wave**:

1. **Single message, multiple Agent calls in parallel** — invoke all relevant subagents (the per-wave list above) on the wave's scope.
2. Each agent returns blockers + concerns + opportunities.
3. Iterate via blocker deltas — apply surgical fixes that close v2 blockers; spawn a v3 only if v2 fixes don't fully close.
4. Begin code work.

**Don't** invoke subagents per PR — wave-level is the right granularity. PRs within a wave that touch new surfaces (e.g., security-reviewer for any new auth code, data-architect for any new migration) get their own per-PR agent call as before.

**For Wave 0 specifically**: agent scan should also include `ux-critic` because the homepage rewrite is part of the wave deliverable.

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
3. **NEW from data-architect delta pass:** "every migration has ROLLBACK.md" was previously asserted; **disk truth = zero ROLLBACK.md files exist**. Wave 0 backfills 0013–0020 and drills one.

**Heuristic for next session:** when seeding or hand-writing SQL against a fresh Supabase, look up the **call-site code** (not the schema comment, not the migration text) to find what convention is actually in use. Tests are also a reliable mirror.

### CodeQL `js/user-controlled-bypass`

Surfaced on PR #183. The rule fires when user input gates ANY action in the branch — even logging or throwing. Resolution pattern: pull side effects OUT of the user-input branch; leave only computation + literal exception throw inside.

### Smoke sandbox in staging (do not delete)

Persists for canary onboarding reuse:

- tenant `smoke-test` (id `2c86133c-6af5-4096-b5ca-4202634cf027`)
- owner `smoke-owner@panorama.invalid` — password in operator's password manager
- 1 category + 1 model + 1 asset (`SMOKE-ASSET-001`)
- 1 reservation history (audit chain begins with 12+ rows)

### Production-readiness gaps tech-lead flagged (load-bearing for free-hosted public preview)

1. **Observability** — `apps/core-api/src/main.ts:1` uses default Nest `Logger` (line-formatted strings to stdout); no Sentry/OTEL/pino. First incident reconstructed from `fly logs | grep` archaeology. Half-day fix; required for Wave 0.
2. **Per-tenant throttler** — ThrottlerModule wired at app level only. One noisy tenant can starve others. Required for any multi-tenant hosting.
3. **Photo-pipeline BullMQ + Redis worker process** isn't wired — synchronous handling of any queued work blocks request threads. Latent risk under load.
4. **Connection_limit math** — explicit per-Fly-instance value pinned in deploy config; data-architect's caveat about pgBouncer client-connection ceilings.
5. **Bus factor of 1 (#50)** — at 10 paying tenants, 3am pages are real. Mitigation = "document everything to the level a stranger can run it." That's literally what this handoff is for.

### vitormr.dev personal-page Panorama copy (recommendation, owner action)

The Panorama mention on the maintainer's personal site
(https://vitormr.dev) currently reads:

> Open-source IT asset + fleet management
> Successor to Snipe-IT plus a custom scheduling overlay. Multi-tenant
> Postgres RLS, OIDC, trilingual EN/PT-BR/ES. Born from a real need at
> AECOM B&P Tunnel program. AGPL-3.0 + Enterprise.

Recommended rewrite (committee delta — Option B, chosen by maintainer
because Snipe-IT/SnipeScheduler aren't framing the project anymore):

> One open-source platform for IT assets AND operational fleet —
> laptops, vehicles, licenses, equipment, in one pane.
> Multi-tenant Postgres RLS, OIDC, hash-chained audit, trilingual
> EN/PT-BR/ES.
> AGPL-3.0 (fork-friendly). Free hosted preview coming.

Rationale: drops the "successor to" framing (Panorama stands on its
own), drops the "AGPL + Enterprise" tag (commercial-leaning;
inconsistent with free-hosted-preview pivot), keeps technical
credibility signals (RLS/OIDC/trilingual), keeps licensing
transparency. Personal-page edit is owner action, not a Panorama-repo
change.

---

## Numbers

- 17 merged PRs in one extended session (continuation across day)
- 8 issues closed (4 by today's PRs, 4 stale-but-actually-done backfilled)
- 3 follow-up issues filed (all ecosystem-gated)
- Tests: 408 → 418 (+10 net)
- Long-standing peer warning (`@nestjs/swagger 7 → mapped-types → class-validator`) cleared
- Long-standing OIDC e2e gap (called out in 2 prior PRs) closed
- Supabase staging: stood up + smoke-tested + sandbox-tenant persists
- 5-agent committee + ux-critic delta pass converged on Wave-0 prerequisite + free-hosted public-preview positioning
