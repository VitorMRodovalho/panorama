# ADR-0020: Self-serve OIDC signup (Wave 0.5)

- Status: **Accepted (2026-05-16, amended same day).** Security-
  reviewer follow-up threat model pass complete; §§1–8 amended with
  C1–C7 (state contract, UUID slug, email-verification hardening,
  three-bucket throttler with `TRUST_PROXY_HOPS`, Turnstile lock
  with timing-padded 400 responses, audit-action expansion,
  deletion-race resolutions, signed-URL hygiene). Recommendations
  R1–R5 tracked as implementation TODOs.
- Date: 2026-05-16
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (Wave 0 scan, 2026-05-16):
  - security-reviewer (initial scan) → flagged self-serve as needing
    its own threat model carve-out (B3 in the scan); this ADR is the
    carve-out
  - security-reviewer (follow-up pass, same session) → APPROVE WITH
    CONDITIONS C1–C7; all conditions landed as the §§1–8 amendments
    above; APPROVE on the amended design
  - product-lead → SUPPORT (self-serve removes the hand-provisioning
    bottleneck that would otherwise gate organic signup signal)
  - tech-lead → no objection on architecture (OIDC-only avoids the
    password-vector surface entirely; existing OIDC stack from
    ADR-0010 + 2026-05-09 PR #190 is reusable)
  - data-architect → no objection (one tenant per email is a clean
    one-row-per-signup invariant; deletion cool-off lock surfaces
    are existing patterns)
  - persona-fleet-ops → SUPPORT (an ops manager can self-serve a
    trial in 60 seconds, which is the funnel the hosted instance
    needs to be evaluable)
- Related: [ADR-0008 Invitation flow](./0008-invitation-flow.md)
  (existing email-token + TTL + audit pattern, reusable for email-
  verification),
  [ADR-0010 Snipe-IT compat shim — auth model](./0010-snipeit-compat-shim-auth.md)
  (existing OIDC + PAT auth surface),
  [ADR-0014 Public hosted instance](./0014-public-hosted-instance.md)
  (the hosted instance this ADR provisions tenants for)

## Context

ADR-0014 commits to a public hosted instance of the Community edition.
For that instance to deliver the "ops manager evaluates Panorama in
60 seconds" funnel that justifies its existence (per ADR-0014 §A),
there must be a path from "I clicked Get a hosted account" to
"I'm logged in to my own tenant" without the maintainer in the loop.

The Wave 0 6-agent scan on 2026-05-16 surfaced two viable signup
models:

- **(a) Invitation-only** — request-access form on the homepage emails
  the maintainer; maintainer provisions the tenant manually via
  `smoke-staging-seed.ts`. Wave 0 closes faster + cleaner. The
  "data-export button before signup" claim is met by docs showing
  operators how to request export.
- **(b) Self-serve OIDC** — full automated signup via Google or
  Microsoft OIDC, one tenant per email, with email-verification + per-
  IP rate-limit + CAPTCHA + audit-emit. Larger Wave 0 scope (security-
  reviewer flagged as needing its own threat model). ~2-3 days of
  additional work versus path (a).

The maintainer chose path (b) on 2026-05-16. This ADR scopes that
choice.

## Decision

Panorama's hosted instance offers **self-serve OIDC signup** with the
following invariants:

### 1. OIDC-only — no password vector

Signup happens via Google or Microsoft OIDC (already integrated per
ADR-0010 + PR #190's e2e validation). There is **no password signup**
on the hosted instance. This removes the credential-stuffing attack
surface entirely and offloads identity proofing to the IdP.

If the user lacks a Google or Microsoft account, the alternative is
to self-host (the AGPL self-host path explicitly supports any OIDC
provider). The hosted instance does not need to be every-user-
welcoming; it needs to be safe.

### 1a. Signup-flow `state` parameter (CSRF defense)

Signup is a *different* OIDC flow than login: at login the callback
binds the IdP response to an existing session; at signup the callback
binds it to a tenant-creation transaction. The CSRF surface is wider,
so the signup callback MUST enforce a stricter `state` contract than
the login callback:

- The signup-initiate endpoint generates a `state` parameter that
  is a **server-side one-time-use record** (Redis, 5min TTL), NOT a
  signed cookie. A leaked `SESSION_SECRET` would forge a cookie-only
  state; a Redis-backed record forces the breach surface up to "DB +
  Redis simultaneously," which is a meaningfully higher bar.
- The state record carries `purpose: 'signup'`. The callback MUST
  reject any callback whose state record does not have
  `purpose === 'signup'` (defends against confused-deputy: an
  attacker initiates a login flow and tricks a victim into completing
  a signup-shaped callback, or vice versa).
- The callback MUST reject any request that arrives with an existing
  authenticated session — signup is initiated from a logged-out
  browser by definition. A logged-in user that wants to provision a
  second tenant uses the existing invitation flow (ADR-0008), not
  signup.
- A state-record mismatch emits
  `panorama.auth.signup_oidc_state_mismatch` (see §6) so SIEM can
  alert on signup-CSRF attempts. The `reason` field discriminates
  the specific contract violation:
  - `missing` — no Redis record for the supplied state key (expired
    or forged)
  - `wrong_purpose` — state record's `purpose !== 'signup'`
    (confused-deputy across login/signup flows)
  - `session_attached` — caller arrived with an existing session
  - `unknown_provider` — `:provider` path is not `google` /
    `microsoft`, or the provider is not configured on this deployment
  - `callback_provider_mismatch` — path `:provider` does not match
    the provider recorded at initiate (attempt to swap provider
    mid-flow)
  - `idp_error` — IdP redirected with `?error=...` per RFC 6749
    §4.1.2.1; the sanitized code rides in `metadata.idpErrorCode`

### 2. One tenant per email (initial signup)

Each successful OIDC signup creates exactly one tenant with the
signup email's user as Tenant Owner.

**Implementation enforcement (PR 1):** the callback REFUSES the
signup when `AuthService.resolveOidcUserForSignup` reports
`pathTaken !== 'new_user'` — i.e. when the IdP identity is already
linked to a Panorama account (`existing_identity`) or when the
asserted email already maps to a pre-existing User row that would be
newly linked (`email_link`). The refusal emits
`panorama.tenant.signup_refused_existing_account` (see §6) and
funnels through the §5 timing-padded 400 envelope. Without this
check, a single Google/Microsoft account could mint up to 3 tenants
per (iss, sub) per 24h (the §4 bucket-3 cap) via repeated signup
attempts at the upper edge of the budget.

Future enhancement (deferred): allow a user to be Owner of multiple
tenants by inviting themselves under a different email or by
accepting an invitation to join an existing tenant — both already
supported via the existing invitation flow (ADR-0008).

### 2a. Tenant identifier is UUID; display name is free text

Tenant URL slugs and primary identifiers MUST be opaque UUIDs (the
existing `Tenant.id` column). There is NO human-readable tenant slug
on the hosted instance. The tenant's display name ("Acme Transit") is
a separate non-unique text field shown in the UI but never in URLs or
unique-key positions.

Reasoning: a first-mover-takes-all human-readable namespace creates a
press-grade incident on day 1 of the public URL — a scripted attacker
with 5 Google accounts can register `amtrak`, `mta`, `bart`, `tfl`,
`septa` in under 5 minutes (well under any per-IP cap, well within any
CAPTCHA challenge budget). A real customer signing up later finds
their org name owned by a squatter, with no clean remediation path.
UUID identifiers + free-text display names sidestep the entire class:
no scarcity, nothing to squat, no homograph attack vector (cyrillic
`аmtrak` vs latin `amtrak`).

A future Enterprise-edition feature may add reserved organizational
slugs with verified-domain proof-of-ownership (the same mechanism SaaS
products like GitHub Enterprise use). That is explicitly out of scope
for the Community signup surface this ADR carves out.

### 3. Email-verification gate

Even though OIDC IdPs already verify the email, Panorama emits a
post-signup confirmation email with a one-time-use token (TTL: 24h).
The tenant is provisioned in a `pending_verification` state; the
first login is blocked until the verification token is consumed.

**PR 1 boundary on the "first login is blocked" contract:** the
signup callback (PR 1) intentionally does NOT establish a session
when it provisions the tenant. The browser is redirected to
`/?signup=verify` and the user is expected to consume the
verification token (PR 2 surface) before any session is minted.
Creating a live session in the callback would leave a window between
PR 1 and PR 2 merges where an unverified tenant could be fully used
— the literal §3 contract reading is that no session exists until
the verification token is consumed, and PR 1 honours that. The
`pendingVerification` column added in migration 0022 carries the
state forward; PR 2 reads it in the verify endpoint and flips it
back to false.

This protects against:
- IdP-issued tokens for emails the IdP itself hasn't verified (rare
  but possible)
- Drive-by signups from compromised browser sessions
- Provides an audit-trail point for "user actually controls this
  inbox"

The pattern reuses the existing invitation token machinery from
ADR-0008 (email-token + TTL + one-time-use + audit). No new
abstraction.

**Email target is `email` from the OIDC id_token, NOT a user-supplied
form field.** Signup is OIDC-only (§1), there is no separate email
input. Trusting the IdP-asserted email is correct because it is the
same identity Panorama will use for all subsequent auth; allowing a
divergent user-supplied target would create a phishing-by-proxy
vector (attacker initiates signup, types `victim@acme.com` in a form
field, Panorama sends an unsolicited "verify your tenant" email to
the victim).

**Consume endpoint is `POST /auth/verify`, not `GET`.** The link in
the verification email is an HTML form button that POSTs the token,
not a clickable URL that GETs it. Reason: link-preview bots in
Outlook Safe-Links, Slack unfurl, Mimecast URL Defense, and Gmail's
content-inspection bots will fetch GET links in transit and consume
one-time tokens before the user clicks. The POST form pattern defeats
all known link-preview pre-consumption (none of them submit forms).

**Per-email rate cap: MAX 3 pending verifications per email per 24h.**
Without this cap, an attacker cycling Google accounts could spam
`victim@acme.com` with hundreds of "verify your tenant" emails
(harassment + inbox-pollution-at-scale). The cap is enforced
fail-closed via Redis bucket keyed on the IdP-asserted email
(normalized: lowercase, trim). Hits emit
`panorama.tenant.verification_throttled` (see §6).

### 4. Multi-bucket rate-limit on signup endpoint

The signup endpoint (POST `/auth/signup`) is throttled with **three
independent fail-closed buckets**. Any one bucket trip rejects the
request. The reason for three buckets is that any single shape is
trivially bypassable at attacker scale:

| Bucket | Limit | Defeats |
|---|---|---|
| Per-IP | 5 / IP / hour | Loud single-source flooders |
| Per-IPv4-/24 (or IPv6-/64) | 50 / subnet / 24h | Cheap residential proxies (~$10/mo gives unlimited single IPs but residential pools cluster in /24 ranges) |
| Per OIDC `(iss, sub)` | 3 / (iss, sub) / 24h | A single Google account cycling proxies to mint tenants |

The first two are pre-OIDC-resolution (checked on the
signup-initiate endpoint). The third runs post-OIDC-resolution on
the callback (once `iss` and `sub` claims are known from the
verified id_token).

**Throttler stack reference (amended during PR 1 implementation —
service-level pivot):** Round 3 prereq PR #210 added `signupIp` +
`signupSubnet` named buckets to `ThrottlerModule.forRoot` expecting
the signup endpoint to ride them via `@Throttle` decorators. The
PR 1 implementation discovered a fatal interaction with
`@nestjs/throttler@6.5.0`: `ThrottlerGuard.canActivate` iterates
EVERY named throttler on EVERY route (keyed per-(class, handler,
name)), so `signupIp`'s 5/hour cap would silently apply to
`/auth/login`, `/reservations`, and every other handler at 5/hour.
Opting out would require `@SkipThrottle({signupIp: true,
signupSubnet: true})` on every non-signup controller — brittle and
forgettable.

The implementation therefore moved all three §4 buckets to a
service-level `SignupRateLimits`
(`modules/signup/signup-rate-limits.service.ts`) that invokes the
existing `RateLimiter` (Redis sliding-window, fail-closed) directly.
The `ThrottlerModule` named-bucket entries for `signupIp` +
`signupSubnet` are REMOVED in PR 1 (app.module.ts course-correct on
PR #210). The remaining `ThrottlerModule` buckets (`global`,
`auth`, `upload`) stay; the existing `PerTenantThrottlerGuard`
(APP_GUARD) continues to enforce them on authenticated routes.

Trade-offs of the pivot:

- `+` Buckets are scoped to the signup endpoints by construction;
  no rogue route inherits them.
- `+` Each bucket trip emits `AuthSignupRateLimitTripped` with the
  exact `bucket` label (`ip` / `subnet` / `oidc_sub`) for SIEM
  correlation — the v6 `ThrottlerGuard` exception path doesn't
  carry that label as cleanly.
- `+` The §5 timing-padded 400 envelope is composed in one place
  rather than overriding `throwThrottlingException`.
- `-` PR #210's named-bucket investment in `ThrottlerModule.forRoot`
  is partially reverted (the `signupIp` + `signupSubnet` entries
  drop out). The `subnetKey()` utility from #210 is still load-
  bearing (used by `SignupRateLimits.consumeSubnet`).

**Trust-proxy contract is fragile and self-hosters must configure
it.** `app.set('trust proxy', 1)` means "trust ONE hop." On the
hosted instance that hop is the Fly edge, which DOES overwrite
`X-Forwarded-For` with the real client IP, so `req.ip` is correct.
But:

- If a CDN (Cloudflare, Fastly) is added in front of Fly, hop count
  becomes 2 and `trust proxy 1` reads the Fly-edge IP as `req.ip` —
  every signup attempt buckets to the same Fly-edge IP (fail-united,
  not fail-closed).
- Self-hosters running behind nginx + a CDN will have hop count 2+;
  if they set `trust proxy 1` they have the same problem inverted.

**Required environment contract:** Introduce `TRUST_PROXY_HOPS` env
var (default `1` for the hosted instance, REQUIRED for self-hosters
enabling `FEATURE_SELF_SERVE_SIGNUP`). The bootstrap in `main.ts`
reads this and passes it to `app.set('trust proxy', n)`. The README
+ `docs/runbooks/secrets-inventory.md` (per Round 1) documents the
correct value per deployment topology.

**Anti-spoof assertion in the flood test.** The synthetic flood test
at `apps/core-api/test/abuse/signup-flood.e2e.test.ts` (a sibling of
the existing `apps/core-api/test/login-flood.e2e.test.ts`) MUST
assert all three buckets independently AND MUST include one case
that sends `X-Forwarded-For: 1.2.3.4` from the test loopback and
asserts the bucket is keyed on the loopback IP (NOT `1.2.3.4`) —
i.e., that an external attacker cannot forge themselves out of the
bucket via a header they control.

### 5. CAPTCHA on signup form (Cloudflare Turnstile)

The signup form on the public homepage includes a Cloudflare
Turnstile challenge. This is the abuse cutoff against scripted
signup flooding that rate-limit alone doesn't catch.

**Locked on Turnstile, not hCaptcha.** Three reasons:

1. **Latency profile.** Turnstile's invisible challenge clears in
   <200ms for ~99% of users. hCaptcha's interactive challenges spike
   2–5s on hard variants. Constant-latency padding (below) is
   easier to baseline against a tight latency distribution.
2. **Privacy story.** Turnstile keeps the client IP on Cloudflare's
   infrastructure. hCaptcha sends it to Intuition Machines. For an
   AGPL project marketed as privacy-respecting, Turnstile is the
   better narrative.
3. **Cost shape.** Turnstile is free-unlimited. hCaptcha free tier
   caps at 1M challenges/month — a soft DoS surface if an attacker
   can drain the quota.

CAPTCHA is **client-side rendered, server-side verified** via
Turnstile's siteverify endpoint on every signup attempt. The
verified token result is keyed in Redis for 5 minutes to prevent
double-submit race (two concurrent signup requests sharing one valid
token).

**Constant-latency error envelope (timing-attack defense).** Rate-
limit rejection is sub-millisecond (Redis local). Turnstile
verification is 50–300ms (HTTPS round-trip to Cloudflare). OIDC
token validation is 100–500ms (HTTPS round-trip to Google/Microsoft).
An attacker timing failure paths can distinguish "rate-limited"
(fast) from "CAPTCHA failed" (medium) from "OIDC rejected" (slow)
purely by wall-clock — defeating §5's no-leak goal.

Therefore: **all signup-failure responses MUST be padded to a
constant minimum latency floor (target: ≥600ms, calibrated to the
95th-percentile success-path latency).** All failures share:

- Same response envelope: `{ error: 'signup_failed' }` (no detail)
- Same status code: **400 Bad Request, NOT 429.** Returning 429 on
  rate-limit hits leaks the rate-limit's existence and shape to an
  anonymous attacker — that's reconnaissance value, not operational
  value. (Note: this is a deliberate deviation from the auth-login
  throttler, which DOES return 429 because the audience there is
  authenticated users for whom the 429 carries operational value.)
- Same latency floor (padded async, do not block on real work)

The error message shown in the UI is the generic "Couldn't sign you
up — please try again in a few minutes." Failed attempts still emit
distinct audit actions server-side (see §6), so SIEM can distinguish
rate-limit-trip vs CAPTCHA-fail vs OIDC-refused for incident
response — the leak is only closed from the *attacker's* side.

### 6. Audit emission

The signup, verification, and deletion surfaces emit the following
audit actions. All are added to the registry at
`apps/core-api/src/modules/audit/audit-actions.ts` BEFORE the
endpoints that emit them ship (Round 3 prerequisite).

**Signup + verification lifecycle:**
- `panorama.tenant.signup_initiated` — at the moment the OIDC flow
  starts (registry addition)
- `panorama.tenant.created` — at the moment the tenant is
  provisioned in `pending_verification` state (existing event,
  migrated to registry enum in PR 1)
- `panorama.tenant.signup_refused_existing_account` — §2 enforcement
  in PR 1: the OIDC identity is already linked to a Panorama
  account OR its email matches a pre-existing User row. Refusal
  is fail-closed; the user is told to use the invitation flow
  (ADR-0008) or sign in.
- `panorama.tenant.verification_sent` — when the confirmation email
  is dispatched (registry addition; PR 2)
- `panorama.tenant.verified` — when the user POSTs the verification
  token and the tenant becomes active (registry addition; PR 2)
- `panorama.tenant.verification_throttled` — per-email cap (§3) hit
  (registry addition; PR 2)

**Anonymous-abuse signals:**
- `panorama.auth.signup_rate_limit_tripped` — any of the three §4
  throttler buckets blocks an attempt; metadata records WHICH bucket
  (`ip` / `subnet` / `oidc_sub`) so SIEM can distinguish (registry
  addition)
- `panorama.auth.captcha_failed` — Turnstile verification fails
  server-side (registry addition)
- `panorama.auth.signup_oidc_state_mismatch` — §1a state contract
  violation (missing / expired / wrong purpose / session-attached);
  this is the CSRF-attempt signal (registry addition)

**Deletion lifecycle (§7):**
- `panorama.tenant.delete_requested` — step 1 (registry addition)
- `panorama.tenant.delete_confirmed` — step 2; deletion is now
  scheduled (registry addition)
- `panorama.tenant.delete_cancelled` — cancel during cool-off
  (registry addition; idempotent — second call against an already-
  cancelled tenant is a no-op and emits ONE event, not two)
- `panorama.tenant.delete_veto` — maintainer or peer-Owner vetoes
  a pending deletion (§7 race B; registry addition)
- `panorama.tenant.deleted` — cron purges tenant data (existing
  event, kept as the terminal state)

### 7. Tenant deletion: two-step + 7d cool-off

The hosted instance provides `DELETE /tenants/:tenantId` (Owner-only):

- Step 1: `POST /tenants/:tenantId/delete-request` — sends a
  confirmation email to **ALL Owners of the tenant** (not just the
  requester) with a one-time confirmation token
- Step 2: `POST /tenants/:tenantId/delete-confirm` with the token —
  schedules deletion for 7 days hence
- During the 7-day cool-off:
  - Any Owner can cancel via `POST /tenants/:tenantId/delete-cancel`
  - Any peer Owner OR the platform maintainer can VETO via
    `POST /tenants/:tenantId/delete-veto` (admin console surface)
  - Tenant data remains accessible (login still works)
  - Banner in the UI: "this tenant is scheduled for deletion on
    YYYY-MM-DD; click here to cancel"
- After 7 days: cron job purges tenant data + emits
  `panorama.tenant.deleted`

The 7-day window prevents a compromised Owner credential from
instantly nuking a tenant. The cancel path provides a "I clicked the
wrong button" recovery; the veto path provides a peer-recovery
channel when the credential compromise also captures the inbox
(see race B below).

**Race conditions (resolution rules):**

- **Race A — concurrent `delete-cancel` and `delete-confirm`.**
  Compromised credential triggers confirm at T+0; legitimate Owner
  POSTs cancel at T+50ms. Both succeed at the HTTP layer because
  deletion is a 7-day scheduled job, not an immediate action.
  Resolution: **last-writer-wins on the `deletionScheduledAt`
  column** (cancel sets it to NULL; confirm sets it to T+7d). Both
  events are audited; the UI banner shows the most-recent action.
  This is intentionally cancel-friendly — the user-friendly outcome
  wins.
- **Race B — credential compromise captures the inbox.** If the
  attacker holds the Owner's Google credentials, they also hold the
  Google inbox where the confirm token lands; the 7-day window
  collapses to zero. This is not fixable without a second factor
  outside the OIDC inbox. Mitigations: (a) the delete-request email
  goes to ALL Owners of the tenant, so a multi-Owner setup gives
  peer-recovery; (b) the platform maintainer can veto a pending
  deletion via the admin console during the 7-day window; (c) Owners
  are encouraged (UI nudge) to set up account recovery by inviting
  at least one peer Owner with a different OIDC identity (see
  Recommendations §R2). Single-Owner tenants where the Owner is
  fully compromised remain at residual risk — this is documented in
  the hosted instance's risk register.
- **Race C — two concurrent `delete-cancel` requests.** Both UPDATE
  the same row with the same value (`deletionScheduledAt = NULL`).
  Postgres serializes. Resolution: no-op on second call; emit ONE
  `panorama.tenant.delete_cancelled` event, not two (deduplicate by
  checking `deletionScheduledAt IS NULL` before emitting).

Cascade ordering note (per data-architect C6 in Wave 0 scan):
`Tenant.systemActorUserId` has `ON DELETE RESTRICT`. The deletion
service MUST NULL this column (or delete the system user) BEFORE
attempting the cascade-delete on the tenant row. This is service-
layer logic, not a schema change.

### 8. Data export

Self-serve data export is its own endpoint, not coupled to deletion:
`GET /tenants/:tenantId/export` (Owner-only). Per security-reviewer's
abuse defenses:

- Rate limit: 1 export per tenant per 24h, via Redis bucket, fail-
  closed
- Async: response is a job id; the actual export runs in a queue,
  delivered as a signed S3 URL via email when complete
- Audit-emit on every call (`panorama.tenant.export_requested` +
  `panorama.tenant.exported`)
- Inline export of a 100k-row tenant on a hot HTTP path is itself a
  DoS vector; async-only is non-negotiable

**Signed-URL contract.** The pre-signed S3 URL delivered in the
completion email has TTL ≤24h. The URL itself is **never written to
any log line, audit row, or persisted record** — the URL embeds
credentials and persisting it is a credential leak. The audit row
for `panorama.tenant.exported` records:

- The S3 object key (e.g., `exports/tenant-{uuid}/{job-id}.tar.gz`)
- The TTL the URL was minted with
- The recipient email (the Owner's IdP-asserted email)

NOT the signed URL, NOT the query parameters that carry the
signature. Operators retrieving the export object via the audit
trail re-mint a signed URL from the key + their own AWS credentials.

The signup → export path satisfies the "show data-export before
signup" persona-fleet-ops principle: the homepage has a "see what
we'd export for you" link to a sample JSON document showing the
shape of the export, BEFORE the user signs up. Real export only
happens post-signup.

## Recommendations (security-reviewer follow-up, 2026-05-16)

These are non-blocking recommendations from the security-reviewer's
threat-model pass that signed off the §§1–8 amendments above.
Tracked as implementation TODOs, not ADR blockers.

- **R1. Age gate (LGPD Art. 14).** Self-declared "I am 18+"
  checkbox on the signup form. The LGPD Art. 14 obligation applies
  to anyone processing minors' data in Brazil; for an AGPL fleet-
  management product the realistic minor-signup risk is near-zero,
  but a self-declaration is cheap, defensible, and doesn't pretend
  to enforce. Implementation: a required checkbox before the OIDC
  initiate button; refusal blocks signup with a generic message.
- **R2. Account-recovery nudge.** The first Owner of a brand-new
  tenant is by definition alone. If their Google account is
  disabled, the tenant is data-locked. Within 7 days of signup,
  surface a one-time UI prompt asking the Owner to invite at least
  one peer Owner OR link a backup OIDC identity (Google ↔ Microsoft
  cross-link). Not blocking; dismissable but re-surfaced every
  login until satisfied. This is also the practical mitigation for
  §7 race B.
- **R3. Turnstile token Redis dedupe.** Per §5, the verified
  Turnstile token result is keyed in Redis for 5 minutes to prevent
  double-submit race where two signup requests share one valid
  token. Implementation TODO when wiring the Turnstile siteverify
  call.
- **R4. Audit metadata for §6 actions.** Each new audit action
  needs a documented metadata shape (which fields, which are
  required, which carry PII). Land alongside the registry additions
  in the audit-registry PR, mirroring the pattern in
  `audit-actions.ts:34-50`.
- **R5. CTA tracking on signup vs self-host paths.** The hosted-vs-
  self-host CTA tracking that product-lead opportunity 1 calls for
  (Round 7) should fire `panorama.tenant.signup_initiated` with a
  `cta_source` metadata field (`hosted_button` / `selfhost_button`
  / `direct_url`) so the maintainer can read funnel signal from the
  audit trail without standing up analytics infra prematurely.

## Alternatives considered

### A) Invitation-only signup (path (a) from the scan)

Rejected by maintainer 2026-05-16. Path (a) closes Wave 0 faster but
introduces a manual-provisioning bottleneck that throttles the
"organic signup signal" the public preview is supposed to generate.
Each request-access email becomes a maintainer task; at 10
requests/week, that's a meaningful drag on actual product work.

### B) Self-serve with password (no IdP requirement)

Rejected. Password storage adds the credential-stuffing attack
surface that ADR-0010 deliberately avoided. The hosted instance is
free; users without Google/Microsoft accounts can self-host. The
trade-off is acceptable.

### C) Self-serve with magic-link only (no OIDC)

Rejected. Magic-link is convenient but creates email-deliverability
risk: a flaky transactional email layer = users can't sign in. OIDC
sidesteps this entirely (the IdP handles delivery). Magic-link as a
fallback for OIDC-impaired users is a future enhancement, not Wave
0.5.

### D) Skip CAPTCHA, rely on rate-limit + email-verification

Rejected. Rate-limit at 5/hour/IP is bypassable via residential proxy
networks (~$10/month gives an attacker thousands of IPs). Email-
verification creates inboxes-required friction but doesn't prevent
the abuse from being expensive to clean up (orphaned pending tenants,
audit-trail noise). CAPTCHA is the cheap defense that closes this
gap.

## Consequences

### Positive

- Removes the manual-provisioning bottleneck; the maintainer is not in
  the signup path
- Preserves AGPL self-host as the path for OIDC-impaired users (no
  hosted-instance feature creep into "support every IdP")
- Reuses existing invitation-token + audit + OIDC machinery (no net-
  new abstractions)
- Email-verification + CAPTCHA + rate-limit + audit-emit gives a
  defensible defense-in-depth posture against drive-by abuse
- 7-day deletion cool-off prevents credential-compromise nuking and
  gives an "undo" path

### Negative

- Wave 0 scope expands by ~2-3 days to cover the signup endpoint +
  email-verification flow + CAPTCHA integration + threat-model pass
- New attack surface (signup endpoint) requires the security-reviewer
  follow-up pass before code lands
- CAPTCHA introduces a third-party dependency (hCaptcha or Cloudflare
  Turnstile) — both have free tiers but add to the supply-chain list
  in the SBOM
- Email-deliverability becomes load-bearing: a bounced verification
  email = user can't sign in. Wave 0 must include a documented
  process for what to do when verification email bounces (manual
  unverify-and-resend via maintainer admin tool)

### Neutral / locked-in

- One tenant per email (initial signup) means users wanting multiple
  tenants must use the invitation flow — same as today's self-host
  pattern
- The signup endpoint lives in Community surface gated by
  `FEATURE_SELF_SERVE_SIGNUP=false` (see edition-boundary check
  below) — same pattern as `FEATURE_INSPECTIONS` and
  `FEATURE_MAINTENANCE`

## Edition-boundary check (per ADR-0014 §2)

ADR-0014 §2 says: "If this instance ships any code, feature, or
endpoint that does not exist on a vanilla self-host of the same Git
SHA, that is a violation."

The signup endpoint described in this ADR **MUST exist in the
Community edition** to satisfy that lock. It ships disabled by
default behind a `FEATURE_SELF_SERVE_SIGNUP=false` env flag. The
hosted instance enables the flag; self-hosters can enable it too if
they want self-serve on their own deployment (a real use case for
SaaS-style multi-tenant self-hosts).

This makes the endpoint Community surface that's gated by config —
the same pattern as `FEATURE_INSPECTIONS` and `FEATURE_MAINTENANCE`.
No edition-boundary violation; the hosted instance runs identical
binary, just with a different config.

## Implementation notes

Sequencing within Wave 0:

1. **Security-reviewer follow-up pass — DONE 2026-05-16.** APPROVE
   WITH CONDITIONS C1–C7 (rate-limit anti-spoof + three buckets;
   timing-padded 400 envelope; Turnstile lock; email-verification
   target from id_token + POST consume + per-email cap; OIDC `state`
   contract; tenant-slug UUID; deletion-race resolutions). All
   landed as §§1–8 amendments. R1–R5 recommendations tracked as
   implementation TODOs.
2. **Audit registry addition** (Round 3 prerequisite, per §6) —
   adds the new audit actions to `audit-actions.ts` BEFORE the
   endpoints that emit them ship. Eleven new actions versus
   pre-amendment (added: `verification_throttled`,
   `signup_oidc_state_mismatch`, `delete_requested`,
   `delete_confirmed`, `delete_cancelled`, `delete_veto`).
3. **Throttler bucket additions** (Round 3 prerequisite, per §4) —
   per-IPv4-/24 and per-`(iss, sub)` buckets added as `@Throttle`
   declarations or a sibling guard atop the
   `PerTenantThrottlerGuard` shipped in PR #205. `TRUST_PROXY_HOPS`
   env var added with default `1`.
4. **Signup endpoint + email-verification flow** (Round 3, gated on
   §1 + §1a + §3 + §4 + §5).
5. **Data-export endpoint** (Round 3, gated on Round 2's audit chain
   reproducibility — without it, "we audited your export" is
   unverifiable).
6. **Tenant-deletion endpoint** (Round 3, includes the 7-day cron,
   the four lifecycle audit actions, the §7 race A/B/C resolutions,
   and the multi-Owner email fan-out).
7. **Homepage signup form + Turnstile integration** (Round 1 wires
   the form copy; Turnstile + functional submit + R1 age-gate in
   Round 3).
8. **Anti-spoof synthetic flood test** at
   `apps/core-api/test/abuse/signup-flood.e2e.test.ts` (per §4) —
   asserts all three throttler buckets independently AND that a
   forged `X-Forwarded-For` does not move the per-IP bucket.
9. **v2 6-agent scan:** re-run security-reviewer on the implemented
   surface (not the design) before URL flips.

The `FEATURE_SELF_SERVE_SIGNUP` flag defaults to `false` in
Community + `true` on the hosted instance. Self-hosters wanting
multi-tenant signup on their own deployment can flip the flag with
the same defense-in-depth (rate-limit + CAPTCHA + email-verification)
they get from this ADR's implementation.
