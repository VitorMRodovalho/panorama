/**
 * Typed registry of audit actions Panorama emits (#90 / follow-up #28).
 *
 * Audit-action strings are public contract for downstream consumers
 * (alert rules, retention policies, SIEM filters). Without a registry,
 * authors pick sibling names by coin-flip and the namespace fragments.
 * The convention is `panorama.<domain>.<verb>` — this file is the
 * single source of truth for which `<domain>.<verb>` pairs exist.
 *
 * Initial seed scope: `panorama.auth.*`. Other domains
 * (reservation / inspection / maintenance / invitation / blackout /
 * pat / boot / notification / tenant / audit) currently use string
 * literals at call sites. Migrating those is a sibling cleanup PR;
 * this registry is the destination, the call sites move to it as
 * touched.
 *
 * To add a new action:
 *   1. Add the entry below in `panorama.<domain>.<verb>` shape.
 *   2. Use `PanoramaAuditAction.<MemberName>` at the call site (NOT
 *      a string literal).
 *   3. If the action is per-tenant, document the tenant scope in the
 *      JSDoc comment.
 */
export const PanoramaAuditAction = {
  // -------- panorama.auth.* --------
  /**
   * OIDC login refused. Cluster-wide event (`tenantId=null`) per
   * ADR-0003's NULL-strand convention: every tenant admin in the
   * cluster sees this row. Metadata MUST NOT carry per-tenant
   * context. Reasons: `email_not_verified` / `hd_not_allowlisted` /
   * `hd_iss_mismatch` / `hd_email_mismatch` /
   * `oidc_account_link_requires_verified_email`.
   */
  AuthOidcRefused: 'panorama.auth.oidc_refused',
  /**
   * OIDC login succeeded. Cluster-wide event (`tenantId=null`) —
   * visible to every tenant admin. Metadata carries `emailDomain`
   * + `hd` (the corporate IdP domain), which is information about
   * the LOGGED-IN user's organisation that propagates outside that
   * tenant. Considered acceptable because (a) refusals already do
   * the same and (b) the corporate domain is semi-public anyway.
   * Pre-pilot, single-cluster Panorama deployments make this a
   * non-issue; revisit if cross-tenant cluster sharing emerges.
   *
   * Metadata: `provider`, `pathTaken` (`existing_identity` /
   * `email_link` / `new_user`), `viaHdOverride`, `emailDomain`,
   * `hd`, `subjectHash`, `iss`. `actorUserId` populated post-
   * resolution (see #91 / follow-up #28).
   */
  AuthOidcLogin: 'panorama.auth.oidc_login',
  /**
   * Self-serve signup throttler tripped (ADR-0020 §4). Cluster-wide
   * event (`tenantId=null`) — fires before the tenant exists. The
   * `bucket` field distinguishes WHICH of the three §4 buckets
   * tripped so SIEM can alert independently:
   *   - `ip` — 5/IP/hour (the loud single-source tripwire)
   *   - `subnet` — 50/IPv4-/24 or IPv6-/64/day (residential proxy)
   *   - `oidc_sub` — 3/(iss, sub)/24h (single-IdP-account abuse)
   *
   * Metadata: `bucket`, `keyHash` (sha256 first-16 chars — never
   * the raw IP / subnet / sub), `iss` (only set when
   * `bucket === 'oidc_sub'`).
   */
  AuthSignupRateLimitTripped: 'panorama.auth.signup_rate_limit_tripped',
  /**
   * Cloudflare Turnstile verification failed server-side (ADR-0020
   * §5). Cluster-wide event (`tenantId=null`). The user-facing
   * response is the same generic 400 envelope as all other signup
   * failures (timing-padded, see ADR-0020 §5); this audit row is
   * the SERVER-side distinction so operators can tell scripted-
   * abuse-via-no-CAPTCHA-token from genuine-user-failed-challenge.
   *
   * Metadata: `siteverifyErrorCodes` (array from Turnstile's
   * `error-codes` response field), `hostname` (the rendering host),
   * `tokenSha256` (hashed — single-use enforcement is in Redis,
   * this is for replay-attempt detection across logs).
   */
  AuthCaptchaFailed: 'panorama.auth.captcha_failed',
  /**
   * Self-serve signup OIDC `state` parameter contract violation
   * (ADR-0020 §1a). Cluster-wide event (`tenantId=null`). This is
   * the CSRF-on-signup-callback detection signal — SIEM SHOULD
   * alert on any non-zero rate. Possible causes:
   *   - `missing` — no state record found in Redis (expired or
   *     forged)
   *   - `wrong_purpose` — state record has `purpose !== 'signup'`
   *     (confused-deputy: login state being replayed against the
   *     signup callback, or vice versa)
   *   - `session_attached` — caller arrived with an existing
   *     authenticated session (signup is logged-out-only)
   *   - `unknown_provider` — the `:provider` path segment is not
   *     `google` or `microsoft`, or the provider is not configured
   *     on this deployment. Carries no real CSRF signal but rides
   *     the same audit row so the timing-padded refusal has a
   *     consistent SIEM home.
   *   - `callback_provider_mismatch` — the path `:provider` differs
   *     from what the initiating state record locked in (an attacker
   *     trying to swap providers mid-flow, or a misconfigured client).
   *   - `idp_error` — the IdP redirected with `?error=...` (RFC 6749
   *     §4.1.2.1). Operationally distinct from a state CSRF but
   *     groups under the same SIEM channel for the signup-callback
   *     refusal aggregate.
   *
   * Metadata: `reason` (one of the above), `stateKeyPrefix` (first
   * 8 chars of the state key — full key is sensitive), `iss` (if
   * the OIDC callback was reached), `hasSession` (boolean),
   * `idpErrorCode` (sanitized; only set when `reason === 'idp_error'`).
   */
  AuthSignupOidcStateMismatch: 'panorama.auth.signup_oidc_state_mismatch',

  // -------- panorama.tenant.* --------
  /**
   * Tenant provisioned. Per-tenant event. Fired by every tenant-
   * creation path: `TenantAdminService.createTenantWithOwner` (the
   * admin / seed surface) AND the self-serve OIDC signup callback
   * (ADR-0020 §1). Migrated from a string-literal call site in
   * `tenant-admin.service.ts` as part of the signup endpoint PR
   * because the new emit site (signup callback) wants the enum
   * anyway — the registry's "migrate as touched" policy applies.
   *
   * Metadata (varies by call site, common keys documented here):
   *   - `slug` — Tenant.slug at creation. For self-serve signup
   *     `slug === tenant.id` (UUID) per ADR-0020 §2a; for admin
   *     creation it is the operator-supplied human-readable slug.
   *   - `ownerUserId` — first Owner's user id
   *   - `ownerMembershipId` — first Owner membership row id
   *   - `pendingVerification` — true ONLY for self-serve signup
   *     (ADR-0020 §3); identifies tenants the future verify endpoint
   *     must unlock before the first login.
   *   - `provider` — `google` / `microsoft` for signup; absent for
   *     non-signup paths.
   *   - `ctaSource` — R5 funnel-signal source on signup; absent for
   *     non-signup paths.
   */
  TenantCreated: 'panorama.tenant.created',
  /**
   * Self-serve signup OIDC flow initiated (ADR-0020 §1). Cluster-
   * wide event (`tenantId=null`) — the tenant does not exist yet.
   * Fired at the moment the signup-initiate endpoint accepts the
   * request and redirects to the IdP.
   *
   * Metadata: `provider` (`google` / `microsoft`), `ctaSource`
   * (`hosted_button` / `selfhost_button` / `direct_url` — per R5
   * recommendation; the funnel-signal source), `userAgentHash`
   * (sha256 of the UA string — for bot-pattern detection without
   * persisting the raw UA), `stateKeyPrefix` (first 8 chars; ties
   * this row to the corresponding callback row).
   */
  TenantSignupInitiated: 'panorama.tenant.signup_initiated',
  /**
   * Verification token minted (tenant row inserted, email-row
   * persisted, SMTP submit attempted). Per-tenant event (the tenant
   * exists in `pending_verification` state by this point).
   *
   * Emit happens INSIDE the mint transaction — so the row is present
   * even if the subsequent SMTP submit fails. A separate
   * `TenantVerificationDispatchFailed` row signals the SMTP-side
   * outcome; readers correlating the pair distinguish "minted +
   * delivered" from "minted but SMTP refused" by the presence /
   * absence of the dispatch-failed sibling within the same
   * tokenKeyPrefix window.
   *
   * Metadata: `emailHash` (sha256 of normalized lowercase email —
   * the raw email is on `actorUser`, no need to duplicate), `ttl`
   * (token TTL in seconds, currently 86400), `tokenKeyPrefix`
   * (first 8 hex chars of the sha256 tokenHash — ties this row to
   * the consume row and to any matching dispatch-failed sibling).
   */
  TenantVerificationSent: 'panorama.tenant.verification_sent',
  /**
   * SMTP submission for a verification email failed AFTER the token
   * row was committed. Per-tenant event. Emitted out-of-band (own
   * `audit.record` transaction) because the mint tx already
   * committed by the time the dispatch attempt runs.
   *
   * The user-facing impact: the tenant exists in
   * `pending_verification` state but the recipient never received
   * the email. PR 2b's resend endpoint is the operator-driven
   * recovery; until then, the user can re-signup (consuming a
   * second §3 cap slot) or the maintainer can hand-flip the
   * tenant via super-admin tooling.
   *
   * Metadata: `emailHash`, `tokenKeyPrefix` (ties to the
   * `TenantVerificationSent` row whose dispatch failed), `errKind`
   * (short string from the caught error name, e.g. `Error`,
   * `TimeoutError`).
   */
  TenantVerificationDispatchFailed: 'panorama.tenant.verification_dispatch_failed',
  /**
   * Verification token consumed via POST /auth/verify (ADR-0020
   * §3). Per-tenant event. The tenant transitions from
   * `pending_verification` to `active` in the same transaction
   * that writes this row. One-time-use is enforced by setting the
   * row's `consumedAt` timestamp (NOT a DELETE — preserving the
   * row leaves a verifier-readable audit trail of the
   * successful consume, and the row is reaped later by a cleanup
   * sweep, not at consume time).
   *
   * Metadata: `tokenKeyPrefix` (first 8 hex chars of the sha256
   * tokenHash — ties to the verification_sent row), `elapsedMs`
   * (time between dispatch and consume — used for "verification
   * took N hours" UX telemetry without standing up product
   * analytics).
   */
  TenantVerified: 'panorama.tenant.verified',
  /**
   * POST /auth/verify refused. Cluster-wide event (`tenantId=null`)
   * — the verify endpoint is reached from a logged-out browser
   * before any tenant context applies. SIEM SHOULD alert on
   * sustained non-zero rate (probable token-brute or audit-DoS).
   * Possible reasons:
   *   - `session_attached` — caller arrived with an authenticated
   *     session; the verify endpoint is logged-out-only (mirrors
   *     ADR-0020 §1a's signup-callback contract for the verify
   *     surface).
   *   - `rate_limit_ip` — POST /auth/verify per-IP bucket tripped
   *     (5/IP/hour, parity with signup-initiate).
   *   - `rate_limit_subnet` — POST /auth/verify per-subnet bucket
   *     tripped (50/IPv4-/24 or IPv6-/64/24h, parity with
   *     signup-initiate).
   *
   * Metadata: `reason` (one of the above), `keyHash` (sha256
   * first-16 chars of the per-IP or per-subnet bucket key — only
   * set for the rate_limit_* reasons).
   */
  AuthVerifyRefused: 'panorama.auth.verify_refused',
  /**
   * Self-serve signup refused because the OIDC identity (or its
   * email) already maps to an existing Panorama account (ADR-0020
   * §2 "one tenant per email — initial signup"). Cluster-wide event
   * (`tenantId=null`). Today, multi-tenant ownership rides through
   * the existing invitation flow (ADR-0008); signup is reserved for
   * net-new identities. If `pathTaken !== 'new_user'`, the callback
   * emits this row and refuses with the standard timing-padded 400.
   *
   * Metadata: `pathTaken` (`existing_identity` / `email_link`),
   * `provider`, `iss`, `subjectHash` (sha256 first-16 chars of
   * provider:subject).
   */
  TenantSignupRefusedExistingAccount: 'panorama.tenant.signup_refused_existing_account',
  /**
   * Per-email verification cap (3 pending verifications per email
   * per 24h, ADR-0020 §3) hit. Cluster-wide event (`tenantId=null`)
   * — fires before the tenant exists. This is the harassment-
   * defense signal: an attacker cycling IdP accounts to flood
   * `victim@acme.com` with "verify your tenant" emails trips this.
   *
   * Metadata: `emailHash` (sha256 of normalized lowercase email —
   * NEVER the raw email; the audit-row reader cross-correlates
   * with `TenantSignupInitiated` rows by hash if they need to
   * trace the harassment source).
   */
  TenantVerificationThrottled: 'panorama.tenant.verification_throttled',
  /**
   * Tenant deletion requested via POST /tenants/:id/delete-request
   * (ADR-0020 §7 step 1). Per-tenant event. The delete-request
   * email is fanned out to ALL Owners of the tenant (not just the
   * requester) — see §7 race B mitigation.
   *
   * Metadata: `requestedByUserId`, `ownerCount` (how many Owners
   * received the confirmation email), `tokenKeyPrefix` (ties to
   * delete_confirmed or delete_cancelled row).
   */
  TenantDeleteRequested: 'panorama.tenant.delete_requested',
  /**
   * Tenant deletion confirmed via POST /tenants/:id/delete-confirm
   * (ADR-0020 §7 step 2). Per-tenant event. The tenant row's
   * `deletionScheduledAt` is set to T+7d in the same transaction.
   * The deletion has NOT YET happened — see TenantDeleted for the
   * terminal state.
   *
   * Metadata: `confirmedByUserId`, `scheduledAt` (ISO-8601 of the
   * scheduled purge), `tokenKeyPrefix` (ties to the request row).
   */
  TenantDeleteConfirmed: 'panorama.tenant.delete_confirmed',
  /**
   * Tenant deletion cancelled during the 7-day cool-off (ADR-0020
   * §7). Per-tenant event. IDEMPOTENT — a second cancel call
   * against an already-cancelled tenant is a no-op and emits
   * exactly ONE row (deduplication via
   * `deletionScheduledAt IS NULL` precondition check). See §7
   * race C for the resolution rule.
   *
   * Metadata: `cancelledByUserId`, `previouslyScheduledAt` (the
   * ISO-8601 the cancel cleared).
   */
  TenantDeleteCancelled: 'panorama.tenant.delete_cancelled',
  /**
   * Tenant deletion vetoed via POST /tenants/:id/delete-veto
   * (ADR-0020 §7 race B mitigation). Per-tenant event. Vetoes can
   * come from a peer Tenant Owner OR from the platform maintainer
   * via the admin console. Cancels the pending deletion identical
   * to delete-cancel but emitted as a distinct action so the
   * "credential-compromise recovery happened" signal is searchable
   * in the audit trail.
   *
   * Metadata: `vetoedByUserId`, `vetoSource` (`peer_owner` /
   * `platform_maintainer`), `previouslyScheduledAt`.
   */
  TenantDeleteVeto: 'panorama.tenant.delete_veto',
  /**
   * Tenant data purged by the ADR-0020 §7 cron after the 7-day
   * cool-off elapsed without cancel / veto. Per-tenant event,
   * emitted INSIDE the purge tx BEFORE the cascade DELETE so the
   * row carries `tenantId = <the tenant being purged>` for the
   * per-tenant audit strand. The audit_events table has no FK to
   * tenants(id), so the row survives the cascade and the strand's
   * tail is the deletion event itself.
   *
   * Metadata: `slug`, `displayName` (snapshot pre-purge),
   * `scheduledAt` (the deletionScheduledAt the cron honoured),
   * `requestedByUserId` (the Owner that confirmed the deletion;
   * may be NULL if the User account was deleted between confirm
   * and purge — `tenants.deletionRequestedByUserId` is ON DELETE
   * SET NULL).
   */
  TenantDeleted: 'panorama.tenant.deleted',
} as const;

export type PanoramaAuditAction =
  (typeof PanoramaAuditAction)[keyof typeof PanoramaAuditAction];
