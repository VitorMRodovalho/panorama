# ADR-0020: Self-serve OIDC signup (Wave 0.5)

- Status: Proposed (2026-05-16). Decision on signup model: Accepted.
  Implementation gates on a security-reviewer follow-up threat model
  pass on the rate-limit + email-verification + CAPTCHA design.
- Date: 2026-05-16
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (Wave 0 scan, 2026-05-16):
  - security-reviewer → flagged self-serve as needing its own threat
    model carve-out (B3 in the scan); this ADR is the carve-out, and
    the implementation phase requires a follow-up sec-review pass
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

### 2. One tenant per email (initial signup)

Each successful OIDC signup creates exactly one tenant with the
signup email's user as Tenant Owner. Future enhancement (deferred):
allow a user to be Owner of multiple tenants by inviting themselves
under a different email or by accepting an invitation to join an
existing tenant — both already supported via the existing invitation
flow (ADR-0008).

### 3. Email-verification gate

Even though OIDC IdPs already verify the email, Panorama emits a
post-signup confirmation email with a one-time-use token (TTL: 24h).
The tenant is provisioned in a `pending_verification` state; the
first login is blocked until the verification token is consumed.

This protects against:
- IdP-issued tokens for emails the IdP itself hasn't verified (rare
  but possible)
- Drive-by signups from compromised browser sessions
- Provides an audit-trail point for "user actually controls this
  inbox"

The pattern reuses the existing invitation token machinery from
ADR-0008 (email-token + TTL + one-time-use + audit). No new
abstraction.

### 4. Per-IP rate-limit on signup endpoint

The signup endpoint (POST `/auth/signup` or similar) is throttled at
**5 signups per IP per hour**, fail-closed. This is enforced via the
ThrottlerGuard pattern that Wave 0 Round 2 wires (see
`HANDOFF-2026-05-16-wave0-scan.md`); the signup endpoint MUST be in
the first batch of `@Throttle`-decorated routes.

Per security-reviewer's note on `app.set('trust proxy')`: the
throttler key must use `X-Forwarded-For[0]`, not the LB IP. Without
this fix, all signups appear to come from one IP and share one bucket
— that's not fail-closed, that's fail-united.

### 5. CAPTCHA on signup form

The signup form on the public homepage includes a CAPTCHA challenge
(hCaptcha or Cloudflare Turnstile — TBD by the homepage rewrite PR).
This is the abuse cutoff against scripted signup flooding that
rate-limit alone doesn't catch (rate limit at 5/hour/IP is still
30/day/IP through one residential proxy network).

CAPTCHA is **client-side rendered, server-side verified** on every
signup attempt. CAPTCHA failure returns a generic "verification
failed, please try again" error (do not leak which check failed —
rate limit vs CAPTCHA vs IdP).

### 6. Audit emission

Every signup attempt emits at least:
- `panorama.tenant.signup_initiated` — at the moment the OIDC flow
  starts (audit registry addition)
- `panorama.tenant.created` — at the moment the tenant is provisioned
  in `pending_verification` state (existing event)
- `panorama.tenant.verification_sent` — when the confirmation email
  is dispatched (audit registry addition)
- `panorama.tenant.verified` — when the user clicks the verification
  link and the tenant becomes active (audit registry addition)
- `panorama.auth.signup_rate_limit_tripped` — when the throttler
  blocks an attempt (audit registry addition)
- `panorama.auth.captcha_failed` — when CAPTCHA verification fails
  server-side (audit registry addition)

All new audit actions added to the audit registry
(`apps/core-api/src/modules/audit/audit-actions.ts`) BEFORE the
signup endpoint ships.

### 7. Tenant deletion: two-step + 7d cool-off

The hosted instance provides `DELETE /tenants/:tenantId` (Owner-only):

- Step 1: `POST /tenants/:tenantId/delete-request` — sends an email
  with a one-time confirmation link
- Step 2: `POST /tenants/:tenantId/delete-confirm` with the token —
  schedules deletion for 7 days hence
- During the 7-day cool-off:
  - Owner can cancel via `POST /tenants/:tenantId/delete-cancel`
  - Tenant data remains accessible (login still works)
  - Banner in the UI: "this tenant is scheduled for deletion on
    YYYY-MM-DD; click here to cancel"
- After 7 days: cron job purges tenant data + emits
  `panorama.tenant.deleted`

The 7-day window prevents a compromised Owner credential from
instantly nuking a tenant. The cancel path provides a "I clicked the
wrong button" recovery.

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

The signup → export path satisfies the "show data-export before
signup" persona-fleet-ops principle: the homepage has a "see what
we'd export for you" link to a sample JSON document showing the
shape of the export, BEFORE the user signs up. Real export only
happens post-signup.

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

1. **Security-reviewer follow-up pass** on the threat model in
   §§ 4 + 5 + 7 above — required before Round 3 starts. The follow-
   up validates: rate-limit shape against synthetic flood test;
   CAPTCHA verification flow + failure messaging; email-verification
   token TTL + replay defense; deletion cool-off race conditions
   (e.g., two cancel requests in flight).
2. Audit registry addition (Round 3 prerequisite, per §6) — adds the
   six new audit actions to `audit-actions.ts` BEFORE the endpoints
   that emit them ship.
3. Signup endpoint + email-verification flow (Round 3, gated on §1).
4. Data-export endpoint (Round 3, gated on Round 2's audit chain
   reproducibility — without it, "we audited your export" is
   unverifiable).
5. Tenant-deletion endpoint (Round 3, includes the 7-day cron).
6. Homepage signup form + CAPTCHA integration (Round 1 wires the
   form copy; CAPTCHA + functional submit in Round 3).
7. v2 6-agent scan: re-run security-reviewer on the implemented
   surface before URL flips.

The `FEATURE_SELF_SERVE_SIGNUP` flag defaults to `false` in
Community + `true` on the hosted instance. Self-hosters wanting
multi-tenant signup on their own deployment can flip the flag with
the same defense-in-depth (rate-limit + CAPTCHA + email-verification)
they get from this ADR's implementation.
