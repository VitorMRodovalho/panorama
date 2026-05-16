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
   * Metadata: `bucket`, `key` (hashed — do NOT log raw IP or sub),
   * `attemptIndex` (which attempt in the window tripped), `iss`
   * (only set when `bucket === 'oidc_sub'`).
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
   *
   * Metadata: `reason` (one of the above), `stateKeyPrefix` (first
   * 8 chars of the state key — full key is sensitive), `iss` (if
   * the OIDC callback was reached), `hasSession` (boolean).
   */
  AuthSignupOidcStateMismatch: 'panorama.auth.signup_oidc_state_mismatch',

  // -------- panorama.tenant.* --------
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
   * Verification email dispatched after a successful signup
   * (ADR-0020 §3). Per-tenant event (the tenant exists in
   * `pending_verification` state by this point). Fired after the
   * SMTP submit returns success — bounces are tracked separately
   * (out of scope for this event).
   *
   * Metadata: `emailHash` (sha256 of normalized lowercase email —
   * the raw email is on `actorUser`, no need to duplicate), `ttl`
   * (token TTL in seconds, currently 86400), `tokenKeyPrefix`
   * (first 8 chars of the token — ties this row to the consume
   * row).
   */
  TenantVerificationSent: 'panorama.tenant.verification_sent',
  /**
   * Verification token consumed via POST /auth/verify (ADR-0020
   * §3). Per-tenant event. The tenant transitions from
   * `pending_verification` to `active` in the same transaction
   * that writes this row. One-time-use is enforced by deleting the
   * token row in the same transaction.
   *
   * Metadata: `tokenKeyPrefix` (ties to the verification_sent
   * row), `elapsedMs` (time between dispatch and consume — used
   * for "verification took N hours" UX telemetry without standing
   * up product analytics).
   */
  TenantVerified: 'panorama.tenant.verified',
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
} as const;

export type PanoramaAuditAction =
  (typeof PanoramaAuditAction)[keyof typeof PanoramaAuditAction];
