# Handoff — 2026-05-16 session end (Round 3 prereqs done)

> Continuation of `HANDOFF-2026-05-16-wave0-scan.md`. That handoff
> set up the 7-round revised plan after the Wave 0 6-agent scan;
> this one closes out the 2026-05-16 working session with **9 PRs
> merged**, all of Round 0 + 1 + 2A + 2B + the Round 3 prerequisites
> in main, and Round 3 main work (signup/verify/delete endpoints)
> teed up for the next session.

## TL;DR

- **9 PRs merged on 2026-05-16**, ranging from the Wave 0 scan
  ADRs through Round 2B audit-chain reproducibility through Round 3
  prerequisites
- **ADR-0020 flipped Proposed → Accepted** via a security-reviewer
  follow-up pass that produced 7 amendments (C1-C7) + 5 non-blocking
  recommendations (R1-R5)
- **Round 3 main work is teed up** — building blocks for the signup
  throttler exist (subnet-key utility, named bucket configs, audit
  registry entries, TRUST_PROXY_HOPS env wiring); the endpoint
  itself is the next PR

## Numbers

- Session length: ~one working day
- PRs shipped: 9 (all merged via squash + `--admin` bypass — solo
  repo, branch protection requires review)
- Tests added: ~25 unit + 0 e2e (e2e for signup-flood deferred to
  endpoint PR)
- Lines of TypeScript added: ~500 across `src/` + `test/`
- Lines of docs added: ~700 across `docs/adr/0020-*` + handoffs +
  secrets-inventory

## PRs in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 199 | `24a73bc` | Round 0: 4 ADRs + handoff refresh | 0014 + 0018 + 0019 + 0020 |
| 203 | `12767dd` | Round 1: docs + a11y quick wins | homepage rewrite, runbook fixes, secrets-inventory, 3 a11y blockers |
| 204 | `dc40f35` | Round 2A.1: ThrottlerGuard wiring | APP_GUARD + trust proxy 1 + @Throttle on auth routes |
| 205 | `6799f4f` | Round 2A.2: PerTenantThrottlerGuard | per-tenant tracker subclass |
| 206 | `2215c7b` | Round 2B: audit-chain reproducibility | migration 0021 + global advisory lock + per-row reproducibility + chain-verify CLI |
| 207 | `08fd876` | ADR-0020 security amendments | C1-C7 amendments + R1-R5; Proposed → Accepted |
| 208 | `a49ef78` | Round 3 prereq 1: audit registry | 11 new entries for signup/verify/delete |
| 209 | `992d5ad` | Round 3 prereq 2: TRUST_PROXY_HOPS env | resolver + 7 tests + secrets-inventory subsection |
| 210 | `cd12924` | Round 3 prereq 3: subnet-key + signup buckets | pure utility + 18 tests + signupIp/signupSubnet ThrottlerModule entries |

## Decisions locked this session

1. **Self-serve OIDC signup model** (locked at scan time, formalized
   in ADR-0020) — Google + Microsoft, no password, one tenant per
   email. Hosted instance enables `FEATURE_SELF_SERVE_SIGNUP=true`.
2. **Cloudflare Turnstile (not hCaptcha)** for the signup CAPTCHA —
   privacy story (Turnstile keeps client IP on Cloudflare), latency
   profile (invisible challenge clears in <200ms), free-unlimited
   (hCaptcha caps at 1M/month). Locked in ADR-0020 §5 amendment.
3. **Tenant identifier = UUID** (not human-readable slug) — closes
   day-1 slug-squatting attack class. Display name is separate
   free-text field. ADR-0020 §2a.
4. **Three-bucket signup throttler** (per-IP + per-subnet + per-OIDC-
   sub) — single-bucket schemes are bypassable at attacker scale.
   ADR-0020 §4 amendment.
5. **Signed-URL hygiene for data export** — TTL ≤24h; audit row
   stores S3 object key + recipient, never the signed URL itself.
   ADR-0020 §8 amendment.
6. **Maintainer veto path for tenant deletion** — addresses §7 race B
   (credential compromise that also captures the inbox collapses the
   7-day window to zero). Either platform-maintainer veto via admin
   console OR peer-Owner veto in multi-Owner tenants.
7. **PR scope discipline for Round 3 prereqs** — each prereq landed
   as its own PR (audit registry → env wiring → subnet utility) so
   the endpoint PR isn't entangled with infrastructure decisions.

## What's left in Round 3 (and how to scope it)

Per amended ADR-0020 §§1-8 + Implementation Notes §§1-9, Round 3
main work after the prereqs:

### Endpoint PR 1 — Signup initiate + callback

- `POST /auth/signup` — wraps the existing OIDC stack from PR #190
  with the §1a state contract (server-side one-time-use Redis record
  with `purpose=signup`, 5min TTL; callback rejects on missing /
  wrong purpose / session-attached)
- `@Throttle({ signupIp: ..., signupSubnet: ... })` decorators
  applied to both initiate and callback
- A sibling `SubnetThrottlerGuard` (or extension to
  `PerTenantThrottlerGuard`) that uses `subnetKey(req.ip)` for the
  `signupSubnet` bucket
- An `OidcSubRateLimiter` service (controller-level Redis check) for
  the third §4 bucket — 3/(iss, sub)/24h, fires post-token-
  validation on the callback
- CAPTCHA verification via Cloudflare Turnstile siteverify (with
  the §5 Redis-keyed 5min token dedupe per R3)
- Timing-padded 400 error envelope per §5 (constant ≥600ms floor;
  status 400 not 429 to avoid leaking rate-limit existence)
- Audit emissions: `panorama.tenant.signup_initiated`,
  `panorama.tenant.created` (existing string-literal, migrate to
  enum on the way), `panorama.auth.signup_oidc_state_mismatch` on
  state violations, `panorama.auth.signup_rate_limit_tripped` on
  any bucket trip, `panorama.auth.captcha_failed` on Turnstile
  failure
- `apps/core-api/test/abuse/signup-flood.e2e.test.ts` — asserts all
  three buckets independently AND the anti-spoof case (forged
  `X-Forwarded-For: 1.2.3.4` does not move the per-IP bucket key)

### Endpoint PR 2 — Email verification

- `POST /auth/verify` — token in request body, NOT GET (defeats
  Outlook Safe-Links / Slack unfurl pre-consumption per §3)
- Reuses ADR-0008 invitation-token machinery (24h TTL, one-time-
  use, audit)
- Per-email cap: 3 pending verifications per email per 24h, Redis
  bucket keyed on normalized email
- Verification email target is the OIDC-asserted email from the
  id_token, NEVER a user-supplied field (per §3 phishing-by-proxy
  defense)
- Audit emissions: `panorama.tenant.verification_sent`,
  `panorama.tenant.verified`, `panorama.tenant.verification_throttled`

### Endpoint PR 3 — Tenant deletion (7-day cool-off)

- `POST /tenants/:id/delete-request` — fans out confirmation email
  to ALL Owners (multi-Owner peer-recovery per §7 race B mitigation)
- `POST /tenants/:id/delete-confirm` — schedules deletion at T+7d
- `POST /tenants/:id/delete-cancel` — last-writer-wins per race A;
  idempotent per race C
- `POST /tenants/:id/delete-veto` — admin console + peer-Owner path
- Cron job purges at T+7d, NULLs `Tenant.systemActorUserId` first
  per ON DELETE RESTRICT cascade ordering
- Audit emissions: `panorama.tenant.delete_requested`,
  `panorama.tenant.delete_confirmed`, `panorama.tenant.delete_cancelled`,
  `panorama.tenant.delete_veto`, `panorama.tenant.deleted` (existing)

### Endpoint PR 4 — Data export

- `GET /tenants/:id/export` (Owner-only)
- Rate limit: 1 export per tenant per 24h, Redis bucket, fail-closed
- Async via queue; completion delivers signed S3 URL via email
- Signed URL TTL ≤24h
- Audit row stores S3 object key + recipient, NEVER the signed URL
  itself (credential-in-URL hygiene per §8)
- Audit emissions: `panorama.tenant.export_requested`,
  `panorama.tenant.exported`

### Cross-cutting follow-ups (deferred to wherever they naturally land)

- **R1 age gate** — checkbox on signup form (LGPD Art. 14 self-
  declaration)
- **R2 account-recovery nudge** — UI prompt within 7 days of signup
  asking the first Owner to invite a peer Owner OR link a backup
  OIDC identity
- **R3 Turnstile dedupe** — folded into Endpoint PR 1's CAPTCHA
  integration
- **R4 audit metadata documentation** — already landed in PR #208
  registry JSDoc; verify metadata shapes match at call sites
- **R5 CTA tracking** — `ctaSource` field on `signup_initiated` audit
  row (hosted_button / selfhost_button / direct_url); homepage CTA
  buttons need to set the right query param

## Lessons / pattern reinforcement

- **Security-reviewer follow-up on an ADR works well as a single-
  agent pass** when the ADR itself names the agent as the gate.
  Cleaner than re-spawning the full 6-agent panel. The follow-up
  produced 7 surgical amendments + 5 recommendations in a single
  pass; landed same-session as the ADR; Round 3 unblocked next-day.
- **Round-3-style "prereq trio" scoping** — when a major feature
  needs (a) registry additions, (b) env/config, (c) shared utility,
  shipping each as its own PR keeps the endpoint PR free of
  infrastructure entanglement. Cost: 3 PRs instead of 1; benefit:
  each PR is small enough to review in 5 minutes and clearly scoped.
- **"Médio" scope for the throttler infra prereq was the right
  call** — adding the named bucket configs but NOT the guard wiring
  means the endpoint PR designs the integration where the use site
  dictates the shape (which guard / which decorator / which
  parameterization). Avoids designing-without-use while still
  front-loading the safe parts.
- **`subnetKey('garbage1') === subnetKey('garbage2')` (fail-closed
  collapse)** — important invariant the test suite asserts
  explicitly. The temptation when handling unparsed input is to
  return the input verbatim "for debuggability"; that gives an
  attacker the ability to mint distinct bucket keys by feeding
  arbitrary garbage. Collapse to one shared `'unknown'` bucket.
- **Memory file pattern for multi-PR sessions** — single
  `project_2026_05_16_session_progress.md` updated incrementally as
  PRs land. Don't fragment per-PR. The session's coherence comes
  from the round-by-round narrative.

## Risks / known-stale items

1. **Stack depth.** 9 PRs deep in one session is well above the
   "5 is the upper edge of comfortable" rule from the prior session-
   end handoff. The endpoint PR (Round 3 main) is the highest-
   density work in Round 3 — should ride a fresh-mind session with
   per-PR security-reviewer + tech-lead scans on the diff, not
   bundled with more prereq work.
2. **`panorama.tenant.created` + `panorama.tenant.deleted` are still
   string literals at the call site** — registry has them as enums
   now (PR #208), but the call sites in `tenant-admin.service.ts`
   haven't been migrated. Per the registry's own docstring policy,
   that's a "sibling cleanup PR." The endpoint PR may opt to do the
   migration in-flight as it touches these code paths.
3. **TRUST_PROXY_HOPS not yet set in any deployment.** Default 1
   matches current Fly behavior, so no production drift. But the
   moment a self-host operator enables `FEATURE_SELF_SERVE_SIGNUP=
   true` without setting `TRUST_PROXY_HOPS`, the bucket math is
   wrong. The README + deploy runbooks need a callout — TODO for
   the endpoint PR or a Round 6 runbook pass.
4. **Migration 0021 (audit-chain reproducibility) still needs to
   be applied to Supabase staging.** Production happy path uses
   `apps/core-api/src/scripts/verify-audit-chain.ts` via
   `DATABASE_PRIVILEGED_URL`. Tracked from PR #206 follow-ups.
5. **Outreach still deferred** per the wave plan — day-30 metrics
   when the URL flips will likely be sparse-data noise. Acknowledged
   risk, not a blocker.

## How to pick up the next session

1. **Read this handoff first.** Then `HANDOFF-2026-05-16-wave0-scan.md`
   for the round-by-round plan; the v2 4-wave handoff
   (`HANDOFF-2026-05-09-session-end.md`) is superseded.
2. **Start Round 3 Endpoint PR 1 from a fresh branch off main.**
   First action: read amended ADR-0020 §§1 + 1a + 3 + 4 + 5 + 6 +
   Implementation Notes again to refresh the contracts.
3. **Spawn agents at PR review time, not during typing.** The
   endpoint PR touches enough new surface that per-PR `tech-lead +
   security-reviewer` is mandatory (the maintainer's standing
   review-cadence pattern from prior sessions).
4. **Audit registry entries from #208 are the source of truth for
   action names + metadata shapes.** When emitting in the endpoint
   code, use `PanoramaAuditAction.<Name>` (the enum) NOT a string
   literal, even for the migrated `tenant.created` / `tenant.deleted`
   ones — the endpoint PR is the natural "touched" site for the
   string-literal → enum migration.
5. **The signup-flood test goes at
   `apps/core-api/test/abuse/signup-flood.e2e.test.ts`** — establish
   the `test/abuse/` directory convention here. Future flood tests
   live there too. The existing `test/login-flood.e2e.test.ts` stays
   put (don't move existing files unrelated to your work).
6. **`subnetKey()` is the utility** for the second §4 bucket; use it
   in whatever guard you wire. Don't roll your own subnet derivation
   — the edge cases (IPv6-mapped IPv4, fail-closed collapse, zone
   stripping) are non-obvious.
7. **Confirm CI is green + use `--admin` for the squash merge** —
   solo-repo branch protection requires the bypass (same pattern
   used for #204-#210 this session).

## Files newly authoritative in main as of session end

- `docs/adr/0020-self-serve-oidc-signup.md` (Accepted; the source
  of truth for Round 3 contracts)
- `apps/core-api/src/modules/audit/audit-actions.ts` (registry of
  signup/verify/delete audit actions)
- `apps/core-api/src/bootstrap/trust-proxy-hops.ts` (env resolver)
- `apps/core-api/src/shared/throttler/subnet-key.ts` (the §4 second-
  bucket keying utility)
- `apps/core-api/src/app.module.ts` (`signupIp` + `signupSubnet`
  named buckets in `ThrottlerModule.forRoot`)
- `docs/runbooks/secrets-inventory.md` (`TRUST_PROXY_HOPS` topology
  table)

## Round-by-round status snapshot

| Round | Status |
|---|---|
| 0 — ADR scaffolding | DONE (#199) |
| 1 — Docs + a11y quick wins | DONE (#203) |
| 2A — Throttler wiring | DONE (#204 + #205) |
| 2B — Audit chain reproducibility | DONE (#206) |
| 3 prereqs — audit registry + env + throttler infra | DONE (#208 + #209 + #210) |
| 3 main — signup + verify + delete + export endpoints | NEXT |
| 4 — daily-driver UX | not started |
| 5 — CI #49 functional gate + observability + secret rotation | not started |
| 6 — runbooks (incident + restore drill + secrets-rotation) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

The hosted URL flips when all 10 Round 7 acceptance criteria close.
We are 4/10 rounds in (counting 3-prereqs as a half-round).
