# Handoff — 2026-05-17 (Round 5 PR2 complete)

> Continuation of `HANDOFF-2026-05-17-round-5-pr1-complete.md`. Round 5
> PR2 of the 7-round revised plan from `HANDOFF-2026-05-16-wave0-scan.md`
> is now complete. Closes Wave 0 acceptance §7 (observability shipped:
> pino + Sentry opt-in + request-id ALS). Round 5 has one further item
> in scope (`SESSION_SECRET` secondary-key rotation) before Round 5 can
> be marked DONE.

## TL;DR

- **1 PR merged on 2026-05-17 (fourth session of the day)** — PR #226.
  Closes Wave 0 acceptance §7.
- The observability stack landed in a single PR per the pre-impl
  5-agent decision to bundle (steps 2-5 of ADR-0018 Implementation
  Notes): pino-behind-LoggerService, Sentry opt-in via `SENTRY_DSN`,
  `RequestContextMiddleware` registered FIRST at `AppModule.configure()`
  (before Csrf + Session), and the TenantContext ALS extended with
  `requestId`.
- A global `AllExceptionsFilter` adds `ref: <requestId>` to every
  JSON error body (4xx + 5xx). End users with no log-aggregator
  access paste the `ref` to support and one filter scopes the full
  request — the 5:30am triage path collapses from "grep by minute
  window across all tenants" to one filter line.
- The `req_` prefix on generated request-ids was a persona-fleet-ops
  per-PR BLOCKER — the id is now radio-readable for ops staff
  ("req underscore..." + 17 chars vs 21 chars of soup).
- A CONVERGENT BLOCKER caught at per-PR scan: `@sentry/node@9.47.1`
  loads `requestDataIntegration` + `httpIntegration` +
  `localVariablesIntegration` by default, which auto-attach headers /
  cookies / body / local-vars to events. `integrations: []` alone
  does NOT disable them — `defaultIntegrations: false` does. Without
  the fix, `self-hosting.md`'s "never headers, cookies, bodies" AGPL-
  procurement promise would have been a lie. Both tech-lead and
  security-reviewer flagged it independently.
- ADR-0018 §3 amended in the same PR to record the wiring-location
  move (`AppModule.configure()`, not `AuthModule`) and the inbound-
  header validation regex.
- `docs/en/feature-matrix.md` row 24 (Observability) updated from
  the speculative pre-PR2 wording ("Prometheus metrics, OTLP traces,
  structured logs") to match shipped reality ("Structured JSON logs
  (pino) with request-id + tenant + user correlation; Sentry opt-in";
  Enterprise gets the OTLP/Prom bundle as the wedge). PR2 also adds
  a "How observability is proven" subsection — the audit artefact a
  procurement reviewer expects, mirroring PR1's "How CI proves this"
  pattern.
- `docs/en/self-hosting.md` gains a "Triage a user-reported issue"
  section with the `docker compose logs | grep '"requestId":"..."'`
  recipe, plus the JSON-vs-line-formatted-output upgrade note.

## PR in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 226 | `c768d4d` | Round 5 PR2 — pino + Sentry opt-in + RequestContextMiddleware (ADR-0018) | 17 files changed, +1906 / -39. Four new files in `apps/core-api/src/shared/observability/` (request-context.middleware, pino-logger.service, sentry.bootstrap, all-exceptions.filter). Three new test files (request-context.middleware.test, observability-smoke.e2e.test, all-exceptions-filter.test) — 18 new test cases. ADR-0018 §3 amendment in the same PR. `feature-matrix.md` row 24 updated + "How observability is proven" subsection. `self-hosting.md` triage section. |

## Numbers

- Session length: same working day as Round 3 close + Round 4 close
  + Round 5 PR1 close (2026-05-17 — the fourth bounded session of
  the day)
- PRs shipped: 1 (squash + `--admin` bypass — solo-repo branch
  protection)
- Tests added: 18 (8 unit + 5 e2e smoke + 5 filter unit)
- Suite total — core-api: 513/513 (was 495/495 after Round 5 PR1;
  +18 new)
- Lines of TypeScript added: ~1000 (4 new files in
  shared/observability + 3 new test files)
- Lines of docs added: ~110 across `feature-matrix.md`, `self-
  hosting.md`, ADR-0018 §3 amendment, and `.env.example`
- Agent scans: 5 pre-implementation + 5 per-PR = 10 agent passes;
  1 rev1 iteration to close 2 BLOCKERs (Sentry `defaultIntegrations`
  + `req_` prefix)

## Decisions locked this round

1. **Wiring at `AppModule.configure()`, not `AuthModule`** —
   tech-lead pre-impl BLOCKER. `RequestContextMiddleware` is a
   cross-cutting observability concern, not auth's responsibility.
   Keeping it at the root means a future contributor reorganizing
   `AuthModule` cannot silently break the ordering invariant.
   ADR-0018 §3 amended in the same PR to record the move.
2. **RequestContext FIRST (before CsrfOriginMiddleware)** — every
   response, including CSRF rejections, carries `x-request-id` so
   support correlates them. The security concern about pre-CSRF
   DoS amplification was mitigated by the inbound-header validation
   regex (no log-injection vector). Persona-fleet-ops + tech-lead
   outvoted the security recommendation to place between CSRF and
   Session.
3. **`req_` prefix on generated request-ids** — persona-fleet-ops
   per-PR BLOCKER. Radio-readable for 5:30am ops triage; an ops
   manager can sanity-check the shape ("starts with req?") before
   running the grep. 21 chars total (4-char prefix + 17 random) at
   the same 64-char alphabet ≈ 102 bits of entropy — still
   collision-free at preview scale.
4. **`defaultIntegrations: false` + `skipOpenTelemetrySetup: true`
   on `Sentry.init`** — CONVERGENT BLOCKER from tech-lead +
   security-reviewer on the per-PR scan. `@sentry/node@9.47.1`'s
   `getDefaultIntegrations` returns `requestDataIntegration`,
   `httpIntegration`, `localVariablesIntegration`,
   `consoleIntegration` — all of which auto-attach req
   metadata. `integrations: []` alone does NOT disable them.
   Without this fix, the AGPL-procurement promise in
   `self-hosting.md` ("never headers, cookies, bodies") would have
   been a lie.
5. **pino-redact paths at depth 1-3** — security pre-impl + per-PR.
   Common shapes (`password`, `token`, `secret`, `clientSecret`,
   `apiKey`, `privateKey`, `dsn`, `databaseUrl`) at multiple depths.
   The mixin reads `requestId/tenantId/userId` only — `actorEmail`
   is in TenantContext but explicitly NOT in the mixin (PII / LGPD).
6. **Customer-visible `ref:` in JSON error envelope** —
   persona-fleet-ops pre-impl BLOCKER. Adds 4 lines in the global
   filter; cost trivial; support value enormous. 4xx + 5xx both
   carry `ref`. HttpException-supplied `ref` cannot override the
   trustworthy value (spread order verified). `res.headersSent` →
   `res.end()` rather than rewrite (tech-lead per-PR NON-BLOCKER).
7. **Bundling ADR-0018 steps 2-5 into one PR** — product-lead
   pre-impl smallest-validating-version argument: middleware-
   ordering invariant only meaningful when all four legs land
   together; splitting would create a "logger flipped but ALS not
   yet plumbed" window where tooling built against the new shape
   fails on incomplete state. Bundle was correct.
8. **`AuditEvent.requestId` column DEFERRED to Round 6** —
   data-architect pre-impl + per-PR. The runbook is the consumer
   of the log↔audit join; column add is `TEXT NULL`, no backfill,
   no new index needed (existing `(tenantId, occurredAt DESC)` at
   `schema.prisma:719` covers the realistic query shape). File the
   follow-up issue from this handoff.

## Iterative review pattern (10 agent passes this PR)

5 agents at the pre-implementation stage shaped the design:
- **tech-lead**: AppModule wiring (cross-cutting concern); SessionMiddleware
  inherit-from-outer-frame via spread; smoke test via `metadata.requestId`
  on audit rows rather than pino stream capture
- **security-reviewer**: inbound header validation regex; no Sentry
  auto-capture; actorEmail explicitly redacted from mixin; explicit
  Sentry init flags; pino-redact paths
- **data-architect**: AuditEvent.requestId column deferred (Round 6);
  PrismaService query-event volume gated by LOG_LEVEL; no consumer-
  count concerns on the TenantContext shape extension
- **product-lead**: BLOCK on the audit-artefact gap (added "How
  observability is proven" subsection); BLOCK on the feature-matrix
  row 24 lie (updated to shipped reality); SENTRY_DSN comment-block
  wording; edition-placement decision lives in feature-matrix, not
  ADR-0018
- **persona-fleet-ops**: middleware order (FIRST, before CSRF);
  customer-visible `ref:` in 500 pages (in scope, not Round 7);
  asset-id-in-error context (partial — deferred to follow-up); PII
  surface ruling out `actorEmail`

5 agents at the per-PR stage caught two CONVERGENT BLOCKERs + a
handful of NON-BLOCKERs:
- **tech-lead + security-reviewer (CONVERGENT BLOCKER)**: Sentry
  default integrations leak headers / cookies / body / locals even
  with `integrations: []`. Fixed in rev1 via `defaultIntegrations:
  false` + `skipOpenTelemetrySetup: true`.
- **persona-fleet-ops BLOCKER**: `req_` prefix for radio-readable
  ops triage. Fixed in rev1.
- **tech-lead NON-BLOCKER**: `res.headersSent === true` path
  silently drops the response. Fixed via `res.end()`.
- **security-reviewer NON-BLOCKER**: pino-redact paths shallow-only.
  Expanded to depth 1-3 + extra shapes (`clientSecret`, `apiKey`,
  `privateKey`, `dsn`, `databaseUrl`).
- **persona-fleet-ops NON-BLOCKERs**: triage section misses async-job
  clarification (added); smoke test asserts ref-on-400 but not
  ref-on-500 (added unit test for both branches of the filter);
  tenant.context.ts comment about "boot, cron" reworded to clarify
  BullMQ workers; warn-on-unknown-ref in filter when middleware
  regression hits.
- **data-architect**: APPROVE — zero schema impact, zero migrations,
  no new queries, no indexing changes. Mixin allocation cost is
  trivial at preview scale. Two redaction surfaces (pino + Prisma)
  worth consolidating later but out of scope.
- **product-lead**: SUPPORT — closes Wave 0 §7 cleanly. The
  procurement-trust contract holds. Feature-matrix row 24 update
  matches shipped reality. ADR-0018 §3 amendment in the same PR is
  the right shape.

The 5+5 cadence with a single rev1 iteration to close two
convergent blockers is the same shape PR1 ran. CI-only infra slices
AND observability infra slices both produce real BLOCKERs at
pre-scan and per-PR scan — do not skip either pass on the next
infra PR.

## What's left

### Round 5 remaining (after this PR)

- **PR3 — `SESSION_SECRET` secondary-key support** — iron-session
  accepts an array (primary + secondary); flip-then-drop rotation
  procedure documented in `docs/runbooks/secrets-rotation.md`
  (which lands in Round 6, but the in-code config + the rotation
  recipe paragraph should land here). ~half-day per maintainer
  decision 2026-05-16.

PR3 is independent of PR2 and can land in either order.

### Rounds 6-7 (unchanged)

#### Round 6 — runbooks

- `docs/runbooks/incident.md` (LGPD 72h ANPD clock + breach
  taxonomy)
- `docs/runbooks/restore.md` + restore drill executed once
- `docs/runbooks/secrets-rotation.md` using inventory from
  Round 1
- Register controlled domain + `.well-known/security.txt`
- Round 6 picks up `AuditEvent.requestId` column for log↔audit
  correlation (deferred from PR2 per data-architect)

#### Round 7 — pre-launch + v2 scan + URL flip go/no-go

- Privacy + ToS at `apps/web/src/app/legal/*` (LGPD Art. 9)
- Status page (Upptime on GH Actions)
- SBOM CycloneDX + cosign sigstore keyless sign on release
- README "Backend: production-ready" softened
- Hosted-vs-self-host CTA tracking
- v2 6-agent scan on the closed-blocker delta
- URL flip go/no-go decision recorded as ADR-0014 amendment

## Follow-ups filed during Round 5 PR2

(These need GitHub issues opened post-merge — listed here so the
next session can file them in one batch.)

1. **`AuditEvent.requestId TEXT NULL` column** — log↔audit
   correlation. Scope: column add only, no backfill, no new index.
   Round 6 (runbooks PR).
2. **`tenant-export.service.ts` `dispatchEmail` completed→failed
   bug** — `tenant-export.service.ts:141-155`. The outer `catch`
   calls `markFailed` even though `markCompleted` already ran;
   email failure overwrites the row. Persona N1 per-PR + handoff
   risk item 6. File before Round 5 PR3 so the logger refactor
   doesn't shadow it.
3. **Per-tenant Sentry sampling** — defer until paid-tier signal.
   Reference ADR-0018 Consequences/Negative.
4. **Asset-tag in Sentry tags** — `scope.setTag('assetId',
   req.params.id)` from `AllExceptionsFilter` when the route has
   `:assetId`. Persona NIT1. 0.4 enhancement.
5. **Per-request log-lines histogram + throttle** — track
   `log_lines_per_request_id` first; throttle when signal forces
   it. Persona NIT2.
6. **`SENTRY_TRACES_SAMPLE_RATE` knob in `.env.example`** — even
   though we ship `tracesSampleRate: 0`, operators may want to
   opt into a partial sample. Persona NIT.
7. **`PinoLoggerService.emit()` two-arg error shape** —
   `error(msgString, stackString)` (no context) misclassifies
   the stack as context. Tech-lead NIT2. Low impact (Nest's
   internal emitters don't use this shape).
8. **Consolidate `pino-redact` paths with `PRISMA_REDACT_FIELDS`**
   — two redaction surfaces; one shared source-of-truth would
   reduce drift. Data-architect observation.
9. **Web-side surface for `ref` in 500 pages** — currently
   API-only (response header + JSON body field). Web 500 pages
   should render the value so end users see "ref: req_..." on
   screen. Round 5 PR3 or Round 6.

## Follow-ups deferred during Round 5 PR2 (not blockers)

- **Runtime require.cache guard** — already deferred from PR1
  (same trigger: lands at the same PR as the first enterprise
  package).
- **Dedicated `community-functional` CI job** — already deferred
  from PR1.
- **ADR-0002 "Enforcement" subsection** — already deferred from
  PR1.

## How to pick up the next session

1. **Read this handoff first.** Then
   `HANDOFF-2026-05-17-round-5-pr1-complete.md`,
   `HANDOFF-2026-05-17-round-4-complete.md`,
   `HANDOFF-2026-05-17-round-3-complete.md`, and
   `HANDOFF-2026-05-16-wave0-scan.md` for the full Wave 0 plan.
2. **Two valid next slices, in either order:**
   - **Round 5 PR3 — `SESSION_SECRET` secondary-key support**
     (~half-day per maintainer decision 2026-05-16). Closes
     Round 5. Doesn't move Wave 0 acceptance — neither §7 nor any
     other acceptance criterion names this — but it unblocks the
     Round 6 secrets-rotation runbook.
   - **Round 6 — runbooks (incident + restore drill + secrets-
     rotation)**. Closes Wave 0 §8. Heavier scope; multi-day.
     Picks up `AuditEvent.requestId` column as one of the deferred
     follow-ups from PR2.
3. **Per-PR 5-agent scan stays mandatory.** Round 5 PR2 had real
   CONVERGENT BLOCKERs at per-PR scan (Sentry default
   integrations) that the pre-impl scan didn't catch — the security
   review at per-PR depth uncovered runtime SDK behavior the ADR
   didn't predict. Don't skip the per-PR scan because "the
   pre-impl already approved."
4. **File the 9 follow-up GH issues listed above before starting
   PR3 / Round 6** so they're tracked and the dispatchEmail bug
   doesn't get shadowed by further refactors.
5. **No new migrations from Round 5 PR2.** Schema unchanged this
   round.
6. **Branch protection still has zero required status checks.**
   Job rename from PR1 + this PR's new test files have no
   protected-check coupling.
7. **`FEATURE_SELF_SERVE_SIGNUP` continues default off in prod.**
   The hosted URL flip is gated by ALL 10 Wave 0 acceptance
   criteria; this PR closed §7, leaving 3 still open (§8 Round 6,
   §9 + §10 Round 7).

## Files newly authoritative in main

- `apps/core-api/src/shared/observability/request-context.middleware.ts`
- `apps/core-api/src/shared/observability/pino-logger.service.ts`
- `apps/core-api/src/shared/observability/sentry.bootstrap.ts`
- `apps/core-api/src/shared/observability/all-exceptions.filter.ts`
- `apps/core-api/test/request-context.middleware.test.ts` (8 cases)
- `apps/core-api/test/observability-smoke.e2e.test.ts` (5 cases)
- `apps/core-api/test/all-exceptions-filter.test.ts` (5 cases)
- `apps/core-api/src/modules/tenant/tenant.context.ts`
  (interface extended with `requestId`; EMPTY_CONTEXT constant;
  `currentRequestId()` helper)
- `apps/core-api/src/modules/auth/session.middleware.ts` (now
  inherits `requestId` from the outer ALS frame via spread)
- `apps/core-api/src/app.module.ts` (implements `NestModule` +
  `configure()` wiring `RequestContextMiddleware` first)
- `apps/core-api/src/main.ts` (initSentryIfConfigured before
  NestFactory.create; useLogger(PinoLoggerService) after; global
  AllExceptionsFilter)
- `apps/core-api/.env.example` `LOG_FORMAT` + `SENTRY_DSN` + `SENTRY_RELEASE`
  block; commented-out OTEL stubs with ADR-0018 §A reference
- `docs/adr/0018-observability-stack.md` §3 amendment (wiring
  location + inbound regex)
- `docs/en/feature-matrix.md` row 24 update + "How observability
  is proven" subsection
- `docs/en/self-hosting.md` "Triage a user-reported issue" section
  + JSON-vs-line-formatted upgrade note + reworded "Centralised
  logging / SIEM" line

## Risks / known-stale items

1. **`FEATURE_SELF_SERVE_SIGNUP=false` remains the only gate
   stopping public access today.** PR2 doesn't change this.
   Discipline: do NOT flip the flag until URL-flip acceptance
   criteria close (Round 7 §"Wave 0 acceptance" 10/10).
2. **`S3_*` env vars remain REQUIRED on every deployment** per
   Round 3 PR #216's ObjectStorageModule hoist. Unchanged.
3. **`AllExceptionsFilter`'s residual log-injection risk** —
   `Error.message` freeform strings can carry secrets that
   pino-redact cannot scrub (it operates on keys, not values).
   Documented inline in `pino-logger.service.ts` comments.
   Mitigation in the medium term: code-review discipline + a
   future linter rule against `throw new Error('${...secret}')`.
4. **Sentry free-tier 5K events/month is a soft cap.** Once the
   hosted URL opens and the first real tenants land, watch the
   per-tenant 5xx rate. If a single tenant burns the budget,
   per-tenant sampling becomes a real ADR amendment (follow-up
   #3 above).
5. **`req_` prefix is the documented contract** — changing it
   would break ops staff's mental model. If a future PR proposes
   a different prefix (e.g., to disambiguate against worker job
   ids), update `docs/en/self-hosting.md#triage` in the same PR.
6. **`tenant-export.service.ts` `dispatchEmail` completed→failed
   bug** (handoff risk item 6 from PR1) is STILL UNFIXED in main.
   File issue #2 in the follow-up list above before PR3 lands.
7. **`AuditEvent.requestId` column NOT added.** The runbook
   join (log → audit) currently requires the operator to filter
   by `tenantId + occurredAt window` rather than direct join.
   Round 6 closes this; until then the triage flow is
   documented in `docs/en/self-hosting.md#triage`.
8. **Stack depth.** This was the fourth bounded session of
   2026-05-17 (Round 3 close + Round 4 close + Round 5 PR1 +
   Round 5 PR2). One well-scanned PR per session continues to be
   the sustainable cadence; trying to land PR3 in the same
   session would compress the per-PR scan iteration into noise.

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
| 5 PR1 — no-enterprise-imports + community-smoke functional gate (#49) | DONE (#223) |
| **5 PR2 — observability stack (ADR-0018)** | **DONE (#226)** |
| 5 PR3 — SESSION_SECRET secondary-key rotation | NEXT (independent of PR2) |
| 6 — runbooks (incident + restore drill + secrets-rotation) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

Wave 0 acceptance progress: 7/10 criteria closed (ADRs §1, Round 1
§2, Round 2 §3, Round 3 §4, Round 4 §5, Round 5 PR1 §6,
**Round 5 PR2 §7**). 3 still open: §8 runbooks + restore drill
(Round 6), §9 Privacy/ToS/status/SBOM (Round 7), §10 v2 6-agent
scan (Round 7). The hosted URL flips when all 10 close.
