# Handoff — 2026-05-17 (Round 3 complete)

> Continuation of `HANDOFF-2026-05-16-session-end-round-3-prereqs.md`.
> Round 3 of the revised 7-round plan from `HANDOFF-2026-05-16-wave0-
> scan.md` is now complete. All four ADR-0020 surfaces (signup,
> verify, delete, export) are in main with migrations applied to dev
> + Supabase staging.

## TL;DR

- **5 PRs merged on 2026-05-17**, closing the ADR-0020 self-serve
  lifecycle end-to-end.
- **5 schema migrations applied** to both dev and Supabase staging:
  0021 (audit chain reproducibility — landed prior), 0022
  (Tenant.pendingVerification), 0023 (EmailVerification), 0024
  (Tenant deletion cool-off + `tenant_deletion_tokens`), 0025
  (`tenant_exports`).
- **Round 3 of the 7-round revised plan = DONE**. Rounds 4-7
  remain before the hosted URL can flip.

## PRs in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 212 | `74762ce` | Signup initiate + callback (ADR-0020 §§1-6) | 3 iterative review passes; 6 blockers closed (state contract, refuse non-new-user, no session pre-verify, rate-limit before audit emit, login-flow pendingVerification filter) |
| 213 | `c8e83e5` | normalize ::ffff: IPv6-mapped IPv4 in consumeIp | Security-reviewer follow-up #6 from PR #212 — same-IP collides on dual-stack |
| 214 | `688dc99` | Email verification + flip pendingVerification (§3) | URL fragment `#token=...` per §3; 1 blocker + 3 conditioned closed |
| 215 | `efdb1f8` | Tenant delete 7d cool-off + multi-Owner email + peer veto + cron purge (§7) | Cascade-chain bug in purge (asset_maintenances RESTRICT) caught by tech-lead; explicit reverse-dependency deleteMany now in service |
| 216 | `39faa24` | Self-serve data export (§8) | Session-gated download endpoint (security-reviewer middlebox-prefetch finding); `getSignedUrl` content-type parameterized (was hardcoded JPEG); ObjectStorageModule hoisted out of `conditionalInspections` |

## Numbers

- Session length: ~one working day (continuation of 2026-05-16)
- PRs shipped: 5 (all squash + `--admin` bypass — solo-repo branch
  protection)
- Tests added: 16 e2e + ~30 service-level (signup-flood + verify +
  delete + export + new subnet-key cases)
- Suite total: 51 files / 476 tests passing locally
- Lines of TypeScript added: ~3800 across `src/` + `test/`
- Lines of docs added: ~600 across ADR amendments + ROLLBACK.md +
  migration headers

## Decisions locked this round

1. **Email links use URL FRAGMENT (`#token=...`), not query** for
   verify + delete-request. Link-preview bots (Outlook Safe-Links,
   Slack unfurl, Mimecast URL Defense) GET URLs at delivery time;
   tokens in query would pre-consume before the user clicked.
2. **Export download is session-gated, NOT direct presigned URL** in
   email. Same threat — middlebox prefetch — but now the email links
   to a Panorama route that returns 401 to unauthenticated GETs and
   only mints a 60s S3 URL after Owner-session verification.
3. **`getSignedUrl` accepts content-type + disposition options.**
   Was hardcoded JPEG for inspection photos; export needs
   `application/gzip` + a real filename. Old default preserved for
   backwards-compat; export passes explicit values.
4. **Tenant cascade ordering is explicit reverse-dependency
   `deleteMany`** in `TenantDeletionService.purgeOne`, NOT pure PG
   CASCADE. Reason: schema has two RESTRICT FK classes
   (user-side `table.createdByUserId → users` AND intra-tenant
   `asset_models.categoryId → categories`) that PG's cascade walker
   cannot topologically untangle on its own. ADR-0020 §7 amended to
   spell the full ordering; future tenant-scoped tables MUST extend
   the `purgeOne` deleteMany list.
5. **`Tenant.systemActorUserId` is now nullable.** Migration 0024
   `DROP NOT NULL`. Required by step 2 of the purge sequence;
   `MaintenanceTicketSubscriber` got a defensive null-check + skip.
6. **`ObjectStorageModule` is now always-loaded**, not gated behind
   `FEATURE_INSPECTIONS`. Means every deployment now needs `S3_*`
   env vars. Documented in PR #216's upgrade note.
7. **Email body for export carries Panorama URL, NOT signed URL.**
   Different from PR 2/3 fragment pattern because the surface
   couples auth + download in one round-trip — the session check
   IS the protection.
8. **POST `/tenants/:tenantId/export`** (originally GET in the
   ADR). ADR-0020 §8 amended in PR #216 — every call is state-
   changing (inserts a `tenant_exports` row + emits audit), so
   POST is the honest verb.

## Iterative review pattern reinforced

Per-PR `tech-lead + security-reviewer` scan in parallel before
commit. Cadence across the 5 PRs:

- PR 212 needed 3 iterative passes (security-reviewer flagged the
  cross-flow login bypass on pass 2; the conditional fixes shipped
  in pass 3).
- PR 214 needed 1 iteration (both reviewers' blockers addressed in
  the second pass, regression tests for both fixes in same
  commit).
- PR 215 + 216 each needed 1 iteration. PR 216's
  security-reviewer pass surfaced 3 blockers including the
  middlebox-prefetch architectural finding — re-architected to
  session-gated download in the same PR.

The "iterate via blocker deltas; ship when no blocker remains"
pattern from `feedback_adr_review_cadence` continues to be the
right cadence — reviewers find real issues every pass, and
addressing them in-PR is cheaper than a follow-up.

## What's left (Rounds 4-7 of the 7-round revised plan)

Per `HANDOFF-2026-05-16-wave0-scan.md` §"Round-by-round
sequencing":

### Round 4 — daily-driver UX (persona-fleet-ops + Wave B)

- Approvals queue surface (dedicated `/approvals` OR
  `/reservations` default switch)
- Actor-on-row in reservations
  (`approvedByUserName`/`checkedInByUserName`/`checkedOutByUserName`)
- `apps/web/src/components/page-header.tsx` + h1/h2
  standardization
- Vitest + RTL setup for `apps/web` (one smoke test on
  login/page.tsx)
- Nav reorder per ops verbs
- Tenant-switcher + sign-out into user overflow menu
- Inline-style cleanup in `app-shell.tsx` + `app-nav.tsx`
- Surface previous reservation `damageNote` in next checkout
  disclosure

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

## Follow-ups deferred during Round 3 (not blockers; tracked here)

Carried across PRs 212-216. Each is logged in the respective
commit body; this list is the index.

**From signup (PR 212):**
- Rate-limit-trip Redis dedupe sentinel (cap audit-row volume per
  (bucket, key) within window; reorder already narrowed the
  signal but row volume is still 1-per-request post-trip)
- Salt IP hashes in `AuthSignupRateLimitTripped.metadata.keyHash`
  with a server-side secret (HMAC-SHA256). Pre-existing pattern
  across other audits; sweep PR.
- Audit emission on terminal signup warns
  (`signup_oidc_callback_failed`, `signup_tenant_create_failed`)

**From verify (PR 214):**
- Resend endpoint for SMTP-failed verification dispatches
- Audit emission for verify failures (`already_consumed` +
  valid-but-expired) per security-reviewer R-compromise
- `buildSessionForUser` per-request `pendingVerification` re-check
  (operator un-verifies vs live session)
- Audit retention sweep for consumed/expired
  email_verification rows

**From delete (PR 215):**
- Rate-limit on `/delete-request` (Owner-auth + idempotent at
  data layer; low priority)
- `TenantDeleteRequestEmailFailed` audit row (parallel to PR 2's
  `TenantVerificationDispatchFailed`)
- Response-shape `cancelled: boolean` on `/delete-cancel`
- Refuse `/delete-request` on `pendingVerification=true` tenants
- Audit `actorUserId: null` fallback when requester user was
  deleted between confirm and purge
- Stale-session role re-check (universal posture, not PR-3-
  specific)
- Platform-maintainer veto admin-console surface
  (`vetoSource: 'platform_maintainer'`)

**From export (PR 216):**
- Stuck-job sweeper (worker crash mid-`processing`)
- Per-user rate limit alongside per-tenant 1/24h
- Streaming serializer for large tenants (current path
  in-memory + gzipSync)
- S3 lifecycle rule for export object cleanup past `expiresAt`
- audit_events / inspection_photos / personal_access_tokens /
  notification_events serialization (MVP gaps)
- Resend endpoint for SMTP-failed export dispatches

## How to pick up the next session

1. **Read this handoff first.** Then `HANDOFF-2026-05-16-wave0-
   scan.md` for the round-by-round plan; the v2 4-wave handoff
   (`HANDOFF-2026-05-09-session-end.md`) is superseded.
2. **Start Round 4 from a fresh branch off main.** Round 4 is
   apps/web work (`/approvals` surface, actor-on-row, page-header
   component). Read `HANDOFF-2026-05-16-wave0-scan.md` §"Round 4"
   for the persona-fleet-ops + ux-critic blocker list.
3. **Per-PR scan stays mandatory.** Round 4 is web-facing — bring
   in `ux-critic` and `persona-fleet-ops` agents in addition to
   `tech-lead + security-reviewer`. The 4-agent cadence from
   2026-05-16's Wave 0 scan applies again.
4. **Migrations 0021-0025 are applied to Supabase staging.** No
   pending DB work.
5. **`FEATURE_SELF_SERVE_SIGNUP` continues default off in prod.**
   The hosted URL flip is gated by ALL 10 Round 7 acceptance
   criteria per `HANDOFF-2026-05-16-wave0-scan.md` §"Wave 0
   acceptance".
6. **Branch-protection bypass via `--admin`** stays the pattern
   for solo-repo squash merges.

## Files newly authoritative in main

- `docs/adr/0020-self-serve-oidc-signup.md` — heavily amended
  during Round 3: §3 no-session-on-callback contract, §7
  cascade-ordering enumeration, §8 POST + session-gated download +
  separate 60s-vs-windowSeconds TTL split + MVP serializer
  table list
- `apps/core-api/src/modules/signup/` — initiate + callback
  surface (PR 212)
- `apps/core-api/src/modules/email-verification/` — verify
  endpoint + mint+dispatch hook (PR 214)
- `apps/core-api/src/modules/tenant-deletion/` — 4-endpoint
  delete lifecycle + BullMQ purge cron (PR 215)
- `apps/core-api/src/modules/tenant-export/` — export request +
  worker + session-gated download (PR 216)
- `apps/core-api/src/modules/audit/audit-actions.ts` — 13 new
  enum entries across the Round 3 surfaces
- `apps/core-api/src/modules/object-storage/object-storage.keys.ts`
  + `object-storage.service.ts` — new `TENANT_EXPORT_KEY_REGEX`
  + `validateObjectKeyShape` + parameterized `getSignedUrl`
  content-type/disposition
- `.runAsSuperAdmin.allowlist.json` — 48 calls across 15 files
  (was 32 across 13 pre-Round-3)
- 5 migrations: 0021 + 0022 + 0023 + 0024 + 0025 — all applied to
  Supabase staging

## Risks / known-stale items

1. **`FEATURE_SELF_SERVE_SIGNUP=false` is the only gate stopping
   public access today.** A misconfigured deploy that flips the
   flag without first completing Rounds 4-7 would expose all four
   surfaces. Discipline: do NOT flip the flag until URL-flip
   acceptance criteria close.
2. **`S3_*` env vars are now REQUIRED on every deployment** per
   PR 216's ObjectStorageModule hoist. Operators upgrading from
   pre-PR-4 with `FEATURE_INSPECTIONS=false` AND no S3
   configuration MUST set the S3 env vars before pulling the
   release. `secrets-inventory.md` needs a sweep edit to remove
   the "conditional behind FEATURE_INSPECTIONS" note.
3. **MVP serializer table-list gaps in tenant export.** Photos,
   PATs, audit_events, notifications are NOT in the export today.
   The first LGPD Art. 18 data-subject access request will
   surface which gaps matter; the deferred list in the export
   commit body is the index.
4. **Stack depth.** 4 Round-3-main PRs landed in one session +
   1 follow-up = 5 PRs squashed onto Round 0+1+2A+2B+prereqs from
   the prior session. The TenantDeletionService cascade-ordering
   bug landed only because the tech-lead caught the
   `asset_maintenances` FK chain — without it the cron would
   have silently failed on any real tenant. **Per-PR scans
   stay non-negotiable.**
5. **Email-deliverability remains load-bearing.** Verify (PR 214)
   + Delete-request (PR 215) + Export-ready (PR 216) all require
   SMTP. Resend endpoints are deferred. SMTP-failure audit rows
   exist on verify + export but NOT on delete-request — fold a
   `TenantDeleteRequestEmailFailed` audit in the next sweep.
6. **Outreach still deferred** per the wave plan — Round 7 will
   decide whether to add a "Show HN" / mailing-list nudge before
   or after the URL flip.

## Round-by-round status snapshot

| Round | Status |
|---|---|
| 0 — ADR scaffolding | DONE (#199) |
| 1 — Docs + a11y quick wins | DONE (#203) |
| 2A — Throttler wiring | DONE (#204 + #205) |
| 2B — Audit chain reproducibility | DONE (#206) |
| 3 prereqs — audit registry + env + throttler infra | DONE (#208 + #209 + #210) |
| **3 main — signup + verify + delete + export endpoints** | **DONE (#212 + #213 + #214 + #215 + #216)** |
| 4 — daily-driver UX | NEXT |
| 5 — CI #49 functional gate + observability + secret rotation | not started |
| 6 — runbooks (incident + restore drill + secrets-rotation) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

The hosted URL flips when all 10 Round 7 acceptance criteria
close. We are 5/7 rounds in.
