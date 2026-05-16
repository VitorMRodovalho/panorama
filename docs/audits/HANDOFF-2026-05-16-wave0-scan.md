# Handoff — 2026-05-16 (Wave 0 6-agent scan + decisions + revised plan)

> Continuation of `HANDOFF-2026-05-09-session-end.md` (v2). This doc
> captures the Wave 0 + Wave B 6-agent scan that gates the public
> hosted URL, the four maintainer decisions that locked next-step
> scope, and the revised round-by-round sequencing.
>
> The 4 ADRs drafted from this scan landed in the same session:
> - ADR-0014 — Public hosted instance (replaces the long-reserved slot)
> - ADR-0018 — Observability stack
> - ADR-0019 — Worker process boundary (defer-with-trigger)
> - ADR-0020 — Self-serve OIDC signup (Wave 0.5; Proposed pending
>   security-reviewer threat model follow-up)

## Why this handoff exists

The 2026-05-09 handoff (v2) ended with a wave plan: Wave 0 +
Waves A–D, with per-wave 5-agent scans gating each. The user opened
2026-05-16's session by directing Wave 0 + Wave B+C to run in
parallel (Wave A folded under Round 5 below; Wave C remains as
per-pickup scan later).

The 6-agent scan that followed surfaced findings significantly more
severe than the v2 handoff suggested. Several Wave 0 items were
worse than described; several were already done; one entire wave
(Wave B nav primitive) was misframed as "to build" when it already
exists in `app-shell.tsx` + `app-nav.tsx`.

This handoff captures the corrections + the revised plan.

## Stale claims in v2 handoff (corrected by the scan)

| v2 claim | 2026-05-16 reality |
|---|---|
| "ThrottlerModule is configured app-level only; per-tenant override is the gap" | **ThrottlerGuard is never registered as `APP_GUARD`** — `app.module.ts:82-85` configures named buckets but no guard enforces them. The `auth: 10/min` cap is fictional. `app.set('trust proxy', 1)` is also missing in `main.ts`. (security-reviewer B1; tech-lead B1) |
| "ROLLBACK.md backfill needed for migrations 0013–0020 (zero exist on disk)" | **20/20 migrations have ROLLBACK.md** on disk; the data-architect's prior delta-pass claim was stale. Backfill scope is now: 2 content fixes (0014 FEATURE_MAINTENANCE order; 0020 path) + drill one against pg_dump restore. (data-architect O2 + tech-lead C2) |
| "Wave B #45: build global navigation primitive" | **Already exists** in `app-shell.tsx` + `app-nav.tsx` + wraps every authenticated route via `(authenticated)/layout.tsx`. Real Wave B work is page-header standardization + nav reorder + a11y fixes + first RTL test. (ux-critic) |
| "Audit chain is tamper-evident (hash-chained)" | **Per-row digest is unreproducible** — `audit_events.metadata` is JSONB which recanonicalizes keys on store, so a verifier reading the row cannot recompute the digest input. Migration 0020 only fixed the timestamp arm; the metadata canonicalization hole is still open. SECURITY.md still admits the chain breaks. (security-reviewer B2; data-architect Blocker 3) |
| "No data-export endpoint; will be added Wave 0" | Confirmed missing. Plus: **no signup endpoint either** (only `smoke-staging-seed.ts` provisions tenants today). The Wave 0 acceptance "show export button BEFORE signup" was unbacked. (security-reviewer B3; persona-fleet-ops blocker 5) |

## Decisions locked (maintainer, 2026-05-16)

1. **Signup model: self-serve OIDC** (Google + Microsoft, no
   password). Triggers Wave 0.5 carve-out (ADR-0020). Implementation
   blocked on security-reviewer threat model follow-up.
2. **Worker process: defer with trigger** (ADR-0019). Photo-pipeline
   stays in-process; trigger conditions codified in the ADR.
3. **SESSION_SECRET rotation: secondary-key support** (~half-day).
   iron-session accepts an array; primary+secondary with flip-then-
   drop = zero-downtime rotation.
4. **Outreach: deferred to post-code**. Code first, find humans
   later. Maintainer accepts the risk that day-30 metrics will be
   sparse-data noise. (product-lead block 3+4 acknowledged as open
   risk, not closed.)

## Round-by-round sequencing (Wave 0 + Wave 0.5 + Wave B in parallel)

### Round 0 — docs scaffolding (no code) — DONE in same session as scan

- Refresh handoff (this file)
- ADR-0014 amendment "Public hosted instance" — Accepted
- ADR-0018 "Observability stack" — Accepted
- ADR-0019 "Worker process boundary" — Accepted
- ADR-0020 "Self-serve OIDC signup" — Proposed (pending sec follow-up)

### Round 1 — quick wins (no architectural risk)

Bundle into 1–3 PRs based on natural seams:

- `docs/index.md` rewrite: drop "pre-alpha", drop the 4 feature cards
  (Snipe-IT-positioned), dual CTA (Get hosted / Self-host on GitHub),
  honesty band in same eyeful as hero, trust strip placeholder
- Remove `ignoreDeadLinks: true` from `docs/.vitepress/config.mts`;
  either translate hero + honesty band into PT/ES or remove the
  locale stubs that currently masquerade as translated content
- Fix `apps/core-api/.env.staging` (add `DATABASE_DIRECT_URL` per
  the three-URL contract; current file is from pre-#186 generator)
- `docs/runbooks/setup-supabase-staging.md:172`:
  `connection_limit=1` → `10` (per data-architect Blocker 2 math)
- ROLLBACK.md content fixes (0014 FEATURE_MAINTENANCE order; 0020
  path/heredoc)
- a11y blockers: form labels in
  `apps/web/src/app/(authenticated)/reservations/page.tsx` lines
  466, 535, 580, 632, 663, 671, 693, 703, 717; calendar status
  letter prefix; `<main>` landmark relocation from root layout to
  per-page content area
- `docs/en/roadmap.md` update (0.3 maintenance status; 0.4 reframe
  to public-preview)
- `docs/runbooks/secrets-inventory.md` (35+ env vars enumerated by
  category, per tech-lead C1)

### Round 2 — backend hardening

Two clusters, can be split into 2–4 PRs:

**Cluster 2A — Throttler wiring**
- Register `APP_GUARD: ThrottlerGuard` in `AppModule`
- `app.set('trust proxy', 1)` in `main.ts`
- `@Throttle` decorators on `/auth/login`, `/auth/oidc/:provider/
  callback`, `/invitations/accept`, `/auth/signup` (when ADR-0020
  ships)
- Per-tenant tracker via `getTracker(req)` subclass reading
  `currentTenantId()` from ALS (anonymous routes fall back to IP)
- Synthetic flood test at `apps/core-api/test/abuse/login-flood.e2e.
  ts` — POST `/auth/login` 50× from one synthetic IP, assert 429 on
  attempts ≥11

**Cluster 2B — Audit-chain reproducibility**
- Migration 0021: add `digestPreImage BYTEA` column to
  `audit_events`
- `AuditService.recordWithin` writes the canonical pre-image
- Both notification + PAT triggers (migrations 0015 + 0020) write
  the same canonical pre-image to the new column
- `pg_advisory_xact_lock(hashtext('audit:' || tenantId))` before the
  chain-head SELECT in service AND in trigger functions (closes
  data-architect Blocker 3 + #41 issue 1)
- `OLD.tenantId IS DISTINCT FROM NEW.tenantId` early-return in
  trigger functions (#41 issue 3)
- `WHERE selfHash IS NOT NULL` guard on chain-head SELECT (#41
  issue 4)
- `pnpm chain-verify` CLI at `apps/core-api/src/cli/verify-audit-
  chain.ts`
- `docs/runbooks/verify-audit-chain.md` operator doc
- Update `SECURITY.md` to remove the "trigger breaks the chain"
  admission and replace with the actual current contract

### Round 3 — endpoints (signup + export + delete)

Gated on ADR-0020 security-reviewer follow-up + audit-actions
registry pre-population.

- Audit registry additions (per ADR-0020 §6): six new actions added
  to `apps/core-api/src/modules/audit/audit-actions.ts` BEFORE the
  endpoints that emit them
- Self-serve OIDC signup endpoint (ADR-0020 §1–§5)
  - `FEATURE_SELF_SERVE_SIGNUP` flag (default false; hosted enables)
  - Email-verification token reusing ADR-0008 invitation pattern
  - Per-IP rate-limit (gated on Round 2A throttler wiring)
  - CAPTCHA (hCaptcha or Turnstile — TBD by homepage rewrite PR)
- `GET /tenants/:tenantId/export` (Owner-only, async via queue,
  signed-URL delivery, 1/tenant/24h Redis bucket fail-closed)
- `DELETE /tenants/:tenantId` two-step + 7d cool-off (ADR-0020 §7)
  - `POST /tenants/:tenantId/delete-request` → email
  - `POST /tenants/:tenantId/delete-confirm` → schedule
  - `POST /tenants/:tenantId/delete-cancel` → cancel
  - Cron job purges + emits `panorama.tenant.deleted`
  - Cascade ordering: NULL `Tenant.systemActorUserId` first

### Round 4 — daily-driver UX (persona-fleet-ops blockers + Wave B)

- Approvals queue surface — either dedicated `/approvals` route OR
  flip `/reservations` default to `scope=tenant&status=pending` when
  the user has approval rights; concurrency proof via advisory lock
  + stale-row banner on conflict (closes persona blocker 1 + 3)
- Actor-on-row in reservations — surface
  `approvedByUserName/checkedInByUserName/checkedOutByUserName` from
  fields the schema already captures (closes persona blocker 2)
- Page-header component at `apps/web/src/components/page-header.tsx`
  + standardize h1/h2 across all authenticated pages (closes ux-
  critic concern on heading inconsistency + ux-critic O5 page-header
  reframe)
- Vitest + RTL setup for `apps/web` per tech-lead C3 (jsdom; one
  smoke test on `login/page.tsx`)
- Nav item reorder per ops verbs: Calendar → Reservations →
  Inspections → Assets → Maintenance; group admin items under "Admin
  ▾" overflow (closes persona C13 + ux-critic C7a)
- Tenant-switcher + sign-out moved into user overflow menu (frees
  ~120px header; closes ux-critic C7c+d)
- Inline styles in `app-shell.tsx` + `app-nav.tsx` moved into
  `globals.css` (closes ux-critic C7b)
- Surface previous reservation's `damageNote` in next checkout
  disclosure for same asset (persona opportunity, closes
  FleetManager scar)

### Round 5 — CI + observability + secret rotation

- **#49 ensure-community-complete CI** (Wave A in v2) — promote
  from grep to functional bootstrap-without-Enterprise-flags +
  exercise community paths + assert. **HARD PREREQUISITE for URL
  flip** per product-lead block 1
- Observability stack per ADR-0018: pino behind LoggerService +
  Sentry opt-in via `SENTRY_DSN` + `RequestContextMiddleware`
  before `SessionMiddleware` + extend TenantContext ALS
- SESSION_SECRET secondary-key support per maintainer decision —
  iron-session array config, primary+secondary, flip-then-drop
  rotation procedure documented in secrets-rotation runbook

### Round 6 — runbooks

- `docs/runbooks/incident.md` per security-reviewer C3: breach
  taxonomy, awareness criteria (ciência inequívoca for LGPD 72h
  ANPD clock), comms template, who-does-what, rollback drill
  checkpoints
- `docs/runbooks/restore.md` per data-architect O3 template +
  execute drill on staging, store evidence at
  `docs/audits/restore-drill-<date>/` (RTO/RPO measured + chain-
  verify across restore boundary per data-architect C6)
- `docs/runbooks/secrets-rotation.md` using inventory from Round 1;
  per-secret-category procedure (database, session, OIDC, S3, SMTP,
  Sentry DSN, Redis)
- Register controlled domain (panorama.app or panorama.dev TBD) +
  migrate `security@vitormr.dev` to `security@<domain>` + add
  `.well-known/security.txt` with PGP signature (or
  `Encryption: none` explicit per RFC 9116 §2)

### Round 7 — pre-launch + v2 scan + URL flip go/no-go

- Privacy + ToS at `apps/web/src/app/legal/*` per security-reviewer
  C2: LGPD Art. 9 mandatories, sub-processor CATEGORIES (not
  vendors — threat-model reasoning), plain-language v1 (lawyer
  review deferred per ADR-0014 §C6 trigger)
- Status page (Upptime on GH Actions free) — probe `/health` ONLY,
  no body matching, no tenant-named probes (security C1)
- SBOM CycloneDX from clean `pnpm install --prod --frozen-lockfile`,
  cosign sigstore keyless sign on release
- README "Backend: production-ready" claim softened (security O4)
- Add hosted-vs-self-host CTA tracking on dual CTAs (product
  opportunity 1 — cheap day-1 instrumentation toward Wave D
  decision triggers)
- v2 6-agent scan — re-spawn `tech-lead + data-architect +
  security-reviewer + product-lead + persona-fleet-ops + ux-critic`
  on the closed-blocker delta; iterate until accepted
- URL flip go/no-go decision recorded as ADR-0014 amendment commit

## Wave 0 acceptance (revised)

The hosted URL flips when ALL of:

1. ADR-0014 + ADR-0018 + ADR-0019 + ADR-0020 all Accepted
2. Round 1 quick wins shipped (homepage rewrite + a11y blockers + env/runbook fixes)
3. Round 2 backend hardening shipped (throttler + audit-chain reproducibility, both with tests)
4. Round 3 endpoints shipped (signup + export + delete, all audit-emitting, all rate-limited)
5. Round 4 daily-driver UX shipped (approvals queue + actor-on-row + page-header standardization)
6. Round 5 #49 functional CI gate shipped (Community completeness asserted by tests, not grep)
7. Round 5 observability shipped (pino + Sentry opt-in + request-id ALS)
8. Round 6 runbooks shipped + restore drill executed once with measured RTO/RPO
9. Round 7 Privacy + ToS + status page + SBOM + CTA instrumentation shipped
10. v2 6-agent scan green-lights the closed-blocker delta

Until 10/10 close, the staging URL stays internal and the homepage
honesty band reads "early access — not yet open; sign up to be
notified."

## Open risks (acknowledged, not blocked on)

1. **Outreach deferred** — day-30 metrics will likely be sparse-data
   noise. Maintainer accepted this trade. Possible mitigations: HN
   "Show HN" post on URL flip day; targeted outreach after Round 7.
2. **Personal-page (vitormr.dev) Panorama copy still uses the
   "AGPL + Enterprise" tag** — should update same day URL flips.
   Owner action, not Panorama-repo change.
3. **First reported LGPD Art. 18 data-subject access request** is a
   trigger for lawyer-reviewed Privacy/ToS amendment per ADR-0014.
   Plain-language v1 acceptable; the trigger is the escape hatch.
4. **Bus factor of 1 (#50)** unchanged. Wave 0 runbooks are the
   forcing function — frame each as "documentation for the second
   maintainer who doesn't exist yet."
5. **ADR-0020 implementation gates on a security-reviewer follow-up
   pass** that hasn't been run yet. Round 3 cannot start until that
   pass closes.

## Numbers (pre-Round 1)

- 6 agents convened in parallel; 1 round of scan; 4 maintainer
  decisions; 4 ADRs drafted (3 Accepted + 1 Proposed)
- v1 must-fix list expanded from 10 items to a 7-Round sequencing
  reflecting the scan's surface-level corrections
- Wave 0 scope expanded by ~2-3 days (Wave 0.5 self-serve OIDC
  carve-out)
- Wave A folded into Round 5 (#49 functional CI gate); Wave A's #48
  (damage-flag → maintenance ticket) folded into Round 4 with
  per-tenant `autoOpenMaintenanceFromInspection` UI toggle (closes
  persona C8)
