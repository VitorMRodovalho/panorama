import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import { AuthConfigService } from '../auth/auth.config.js';
import { OidcService, type OidcUserInfo } from '../auth/oidc.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';
import { TenantAdminService } from '../tenant/tenant-admin.service.js';
import { SignupConfigService } from './signup.config.js';
import {
  SignupStateStore,
  type SignupCtaSource,
} from './signup-state.store.js';
import { TurnstileVerifier } from './turnstile-verifier.service.js';
import { SignupRateLimits } from './signup-rate-limits.service.js';
import { respondTimingPadded } from './signup-failure.helper.js';

/**
 * Self-serve OIDC signup endpoints (ADR-0020).
 *
 * Wired under `/auth/signup/:provider/{start,callback}` so the IdP
 * redirect_uri is distinct from the login flow's
 * `/auth/oidc/:provider/callback`. Self-hosters enabling
 * `FEATURE_SELF_SERVE_SIGNUP` must register both redirect_uris.
 *
 * Per ADR-0020:
 *   §1   — OIDC-only, no password vector.
 *   §1a  — `state` is a Redis-backed one-time-use record (NOT a
 *          signed cookie) with `purpose: 'signup'`; the callback
 *          rejects missing / wrong-purpose / session-attached.
 *   §2a  — Tenant.slug = Tenant.id (UUID); no human-readable slug.
 *   §3   — Tenant is provisioned with `pendingVerification=true`.
 *          The callback intentionally does NOT establish a session
 *          — the browser is redirected back to `/?signup=verify`
 *          and the user is expected to consume the verification
 *          token (PR 2 surface) before the first login. Creating
 *          a live session here would let the user access an
 *          unverified tenant in the window between PR 1 + PR 2
 *          (security-reviewer block on the §3 contract literal
 *          reading "first login is blocked until the verification
 *          token is consumed").
 *   §4   — Three independent fail-closed buckets (IP + subnet pre-
 *          OIDC, oidc_sub post-token) via `SignupRateLimits`.
 *   §5   — Turnstile siteverify with Redis dedupe; constant-latency
 *          400 envelope on EVERY failure path (rate-limit trip,
 *          CAPTCHA fail, state mismatch, OIDC refused). Status 400,
 *          NOT 429 — leaking rate-limit shape to anonymous attackers
 *          is reconnaissance value, not operational value.
 *   §6   — Distinct audit actions per failure shape so SIEM can
 *          alert independently.
 *
 * All initiation requests carry the `:provider` path segment and the
 * form body { ctaSource, captchaToken, ageGateAccepted }. Failures
 * funnel through `respondTimingPadded` so the wall-clock leak is
 * closed from the attacker's side (the AUDIT row still carries the
 * specific failure reason for operator triage).
 */
const InitiateBodySchema = z.object({
  captchaToken: z.string().min(1).max(2048),
  ctaSource: z.enum(['hosted_button', 'selfhost_button', 'direct_url']),
  /**
   * R1 age gate (LGPD Art. 14 self-declaration). The homepage form
   * MUST set this to `true` before submit; the server treats `false`
   * / absent as a refusal. No audit row distinguishes age-gate
   * failure from any other shape — it is a UI gate, not a security
   * signal.
   */
  ageGateAccepted: z.literal(true),
});

const ProviderSchema = z.enum(['google', 'microsoft']);

@Controller('auth/signup')
export class SignupController {
  private readonly log = new Logger('SignupController');

  constructor(
    private readonly cfg: SignupConfigService,
    private readonly authCfg: AuthConfigService,
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
    private readonly tenants: TenantAdminService,
    private readonly stateStore: SignupStateStore,
    private readonly turnstile: TurnstileVerifier,
    private readonly limits: SignupRateLimits,
    private readonly audit: AuditService,
  ) {}

  @Post(':provider/start')
  async start(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const startedAt = Date.now();

    // §4 buckets 1 + 2 FIRST — fail-closed. Consumed before any
    // other audit emission so /auth/signup/garbage/start (or any
    // other pre-validation failure path) cannot DoS the
    // `audit:global` advisory lock at high request rates. The
    // bucket trip is the natural ceiling on `AuthSignupRateLimit-
    // Tripped` audit-row volume; everything else (state-mismatch,
    // captcha-failed, etc.) is downstream of these consumes and
    // therefore upper-bounded by the same budget.
    const ipDecision = await this.limits.consumeIp(req.ip);
    if (!ipDecision.allowed) {
      await this.recordRateLimitTrip('ip', req.ip, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    const subnetDecision = await this.limits.consumeSubnet(req.ip);
    if (!subnetDecision.allowed) {
      await this.recordRateLimitTrip('subnet', req.ip, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    const provider = await this.resolveProvider(req, startedAt, res);
    if (!provider) return;

    // §1a — signup is logged-out-only. An existing session is a
    // confused-deputy attempt; emit the audit signal and refuse.
    if (getRequestSession(req)) {
      await this.recordStateMismatch('session_attached', null, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    const parsed = InitiateBodySchema.safeParse(body);
    if (!parsed.success) {
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §5 — Turnstile + Redis token dedupe.
    const turnstile = await this.turnstile.verify(parsed.data.captchaToken, req.ip ?? null);
    if (!turnstile.ok) {
      await this.recordCaptchaFailed(turnstile, parsed.data.captchaToken, req);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §1a — generate Redis state key, build the IdP authorize URL
    // with that key as `?state=`, persist the record with the PKCE
    // verifier + nonce returned by `OidcService.start`. Order matters:
    // a failed authorize-URL build never reaches `set`, so a crash
    // doesn't leave an orphan state row.
    const stateKey = this.stateStore.generateKey();
    const { url, codeVerifier, nonce } = await this.oidc.start({
      provider,
      redirectTo: '/',
      redirectUri: `${this.authCfg.config.baseUrl}/auth/signup/${provider}/callback`,
      state: stateKey,
    });
    await this.stateStore.set(stateKey, {
      purpose: 'signup',
      provider,
      redirectTo: '/',
      ctaSource: parsed.data.ctaSource,
      userAgentHash: hashUserAgent(req.headers['user-agent'] ?? null),
      codeVerifier,
      nonce,
    });

    await this.recordSignupInitiated({
      provider,
      ctaSource: parsed.data.ctaSource,
      userAgent: req.headers['user-agent'] ?? null,
      stateKey,
    });

    res.redirect(302, url);
  }

  @Get(':provider/callback')
  async callback(
    @Query('code') rawCode: unknown,
    @Query('state') rawState: unknown,
    @Query('error') rawIdpError: unknown,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const startedAt = Date.now();
    // Express parses duplicate query params into arrays; the @Query
    // decorator's `string | undefined` type is a TS convenience but
    // does NOT enforce shape at runtime. CodeQL flagged the raw
    // values reaching `.slice(...)` as type-confusion. Narrow to
    // strings at the boundary so every downstream consumer sees the
    // shape it expects.
    const code = typeof rawCode === 'string' ? rawCode : null;
    const stateKey = typeof rawState === 'string' ? rawState : null;
    const idpError = typeof rawIdpError === 'string' ? rawIdpError : null;

    // §4 buckets 1 + 2 FIRST (same rationale as in start()): cap
    // any pre-state-consume audit-emit flood. The callback handler
    // is publicly reachable + has multiple paths that emit audit
    // rows (state mismatch, idp_error, captcha failure cascade if
    // the IdP somehow loops). Bounding by the per-IP and per-subnet
    // budgets caps the audit-chain advisory-lock pressure to the
    // same cap signup-initiate operates under.
    const ipDecision = await this.limits.consumeIp(req.ip);
    if (!ipDecision.allowed) {
      await this.recordRateLimitTrip('ip', req.ip, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    const subnetDecision = await this.limits.consumeSubnet(req.ip);
    if (!subnetDecision.allowed) {
      await this.recordRateLimitTrip('subnet', req.ip, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    const provider = await this.resolveProvider(req, startedAt, res);
    if (!provider) return;

    // §1a — signup callback is logged-out-only.
    if (getRequestSession(req)) {
      await this.recordStateMismatch('session_attached', stateKey, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §1a — consume one-time state. `consume` returns 'missing' for
    // expired / unknown / already-consumed; 'wrong_purpose' for a
    // login-flow record that ended up at the signup callback (or
    // vice versa).
    const consumed = await this.stateStore.consume(stateKey ?? '');
    if (consumed.kind === 'missing') {
      await this.recordStateMismatch('missing', stateKey, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    if (consumed.kind === 'wrong_purpose') {
      await this.recordStateMismatch('wrong_purpose', stateKey, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    const record = consumed.record;

    // RFC 6749 §4.1.2.1 — IdP signals refusal via `?error=`. Same
    // handling as the login callback: log, refuse, never echo the
    // attacker-influenced free-text into the response body.
    if (typeof idpError === 'string' && idpError.length > 0) {
      const safeCode = idpError.slice(0, 64).replace(/[^a-z_-]/gi, '') || 'unknown';
      this.log.warn({ provider, idp_error: safeCode }, 'signup_oidc_idp_error');
      await this.recordStateMismatch('idp_error', stateKey, null, safeCode);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    if (!code || !stateKey) {
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    if (record.provider !== provider) {
      // The path :provider doesn't match what initiate locked into
      // the state record. Distinct from a `missing` state (no
      // record) — emit with `callback_provider_mismatch` so SIEM
      // can distinguish replay-against-wrong-provider from forged-
      // state-key replay.
      await this.recordStateMismatch('callback_provider_mismatch', stateKey, null);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // OIDC token exchange. The callbackUrl mirrors the login pattern
    // (req.originalUrl joined to baseUrl) so openid-client v6 can
    // extract iss + state + code from the actual inbound URL.
    const callbackUrl = new URL(req.originalUrl, this.authCfg.config.baseUrl).href;
    let userInfo: OidcUserInfo;
    try {
      userInfo = await this.oidc.callback({
        provider,
        callbackUrl,
        expectedState: stateKey,
        codeVerifier: record.codeVerifier,
        expectedNonce: record.nonce,
      });
    } catch (err) {
      // OidcService logs the underlying reason; we surface the
      // generic 400 envelope. State has already been GETDEL'd so a
      // retry needs a fresh initiate.
      this.log.warn({ err: String(err) }, 'signup_oidc_callback_failed');
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §4 bucket 3 — post-OIDC. The (iss, sub) tuple is the IdP-stable
    // identifier we couldn't bucket on at initiate.
    if (!userInfo.iss) {
      // RFC 7519 violation — refuse without consuming the bucket.
      this.log.warn({ provider }, 'signup_callback_missing_iss');
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }
    const oidcDecision = await this.limits.consumeOidcSub(userInfo.iss, userInfo.subject);
    if (!oidcDecision.allowed) {
      await this.recordRateLimitTrip('oidc_sub', null, userInfo.iss);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §1 — resolve or create the user via OIDC. Mirrors loginWithOidc's
    // gate (email_verified / workspace-hd override) so signup respects
    // the same identity-proof contract as login.
    let resolved: Awaited<ReturnType<AuthService['resolveOidcUserForSignup']>>;
    try {
      resolved = await this.auth.resolveOidcUserForSignup(provider, userInfo, {
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, 'signup_oidc_user_resolution_failed');
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §2 — one tenant per email (initial signup). If the OIDC
    // identity already maps to a Panorama account (`existing_identity`)
    // OR the email matches a pre-existing User row that gets newly
    // linked (`email_link`), refuse: multi-tenant ownership for
    // existing accounts rides the invitation flow (ADR-0008), not
    // signup. Without this check, a single Google account can
    // mint up to 3 tenants per (iss, sub) per 24h via repeated
    // signup attempts.
    if (resolved.pathTaken !== 'new_user') {
      await this.recordSignupRefusedExisting(provider, userInfo, resolved.pathTaken);
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §2 + §2a + §3 — one tenant per successful signup. Tenant.id +
    // Tenant.slug = freshly-minted UUID (opaque). Tenant ships with
    // `pendingVerification=true`; PR 2's verify endpoint flips it.
    const tenantId = randomUUID();
    const displayName = friendlyDisplayName(resolved.displayName, userInfo.email);
    try {
      await this.tenants.createTenantWithOwner({
        id: tenantId,
        slug: tenantId,
        name: displayName,
        displayName,
        ownerUserId: resolved.userId,
        actorUserId: resolved.userId,
        pendingVerification: true,
        metadataExtra: {
          provider,
          ctaSource: record.ctaSource,
          oidcPathTaken: resolved.pathTaken,
          viaHdOverride: resolved.viaHdOverride,
        },
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_tenant_create_failed');
      return respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
    }

    // §3 — DO NOT establish a session here. The tenant carries
    // `pendingVerification=true`; PR 2's verify endpoint will consume
    // the email token + flip the bit + then mint the session. Until
    // then, the browser must remain logged-out. Redirecting to
    // `/?signup=verify` lets the homepage frontend show a "check your
    // email" UI without leaking session state.
    res.redirect(302, '/?signup=verify');
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * Validate the `:provider` path segment and confirm the deployment
   * has the OIDC client configured. On failure, emit the
   * `unknown_provider` audit row + the timing-padded 400 envelope —
   * a synchronous throw here would leak a wall-clock distinction
   * between "configured but not yet hit a real bucket" vs "rate-
   * limited" to an anonymous attacker (§5).
   *
   * Returns the validated provider on success, or `null` when the
   * caller should short-circuit (the helper has already written the
   * timing-padded 400 to `res`).
   */
  private async resolveProvider(
    req: Request,
    startedAt: number,
    res: Response,
  ): Promise<'google' | 'microsoft' | null> {
    const raw = (req.params as { provider?: string })?.provider ?? '';
    const parsed = ProviderSchema.safeParse(raw);
    if (!parsed.success || !this.authCfg.hasProvider(parsed.data)) {
      await this.recordStateMismatch('unknown_provider', null, null);
      await respondTimingPadded(res, startedAt, this.cfg.config.failureLatencyFloorMs);
      return null;
    }
    return parsed.data;
  }

  // --- audit emission ---------------------------------------------------

  private async recordSignupInitiated(opts: {
    provider: 'google' | 'microsoft';
    ctaSource: SignupCtaSource;
    userAgent: string | null;
    stateKey: string;
  }): Promise<void> {
    try {
      await this.audit.record({
        action: PanoramaAuditAction.TenantSignupInitiated,
        resourceType: 'tenant',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata: {
          provider: opts.provider,
          ctaSource: opts.ctaSource,
          userAgentHash: hashUserAgent(opts.userAgent),
          stateKeyPrefix: opts.stateKey.slice(0, 8),
        },
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_initiated_audit_write_failed');
    }
  }

  private async recordStateMismatch(
    reason:
      | 'missing'
      | 'wrong_purpose'
      | 'session_attached'
      | 'unknown_provider'
      | 'callback_provider_mismatch'
      | 'idp_error',
    stateKey: string | null,
    iss: string | null,
    idpErrorCode?: string,
  ): Promise<void> {
    try {
      const metadata: Record<string, unknown> = {
        reason,
        stateKeyPrefix: stateKey ? stateKey.slice(0, 8) : null,
        iss,
        hasSession: reason === 'session_attached',
      };
      if (idpErrorCode !== undefined) metadata['idpErrorCode'] = idpErrorCode;
      await this.audit.record({
        action: PanoramaAuditAction.AuthSignupOidcStateMismatch,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata,
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_state_mismatch_audit_write_failed');
    }
  }

  private async recordSignupRefusedExisting(
    provider: 'google' | 'microsoft',
    userInfo: OidcUserInfo,
    pathTaken: 'existing_identity' | 'email_link',
  ): Promise<void> {
    try {
      await this.audit.record({
        action: PanoramaAuditAction.TenantSignupRefusedExistingAccount,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata: {
          pathTaken,
          provider,
          iss: userInfo.iss,
          subjectHash: createHash('sha256')
            .update(`${provider}:${userInfo.subject}`)
            .digest('hex')
            .slice(0, 16),
        },
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_refused_existing_audit_write_failed');
    }
  }

  private async recordRateLimitTrip(
    bucket: 'ip' | 'subnet' | 'oidc_sub',
    ip: string | null | undefined,
    iss: string | null,
  ): Promise<void> {
    try {
      const keyMaterial =
        bucket === 'ip' ? (ip ?? 'unknown') : bucket === 'subnet' ? (ip ?? 'unknown') : (iss ?? 'unknown');
      const metadata: Record<string, unknown> = {
        bucket,
        keyHash: createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16),
      };
      if (bucket === 'oidc_sub' && iss) metadata['iss'] = iss;
      await this.audit.record({
        action: PanoramaAuditAction.AuthSignupRateLimitTripped,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata,
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_rate_limit_audit_write_failed');
    }
  }

  private async recordCaptchaFailed(
    result: { ok: false; reason: string; siteverifyErrorCodes?: string[] },
    token: string,
    req: Request,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: PanoramaAuditAction.AuthCaptchaFailed,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          reason: result.reason,
          siteverifyErrorCodes: result.siteverifyErrorCodes ?? [],
          hostname: req.headers['host'] ?? null,
          tokenSha256: createHash('sha256').update(token).digest('hex'),
        },
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'signup_captcha_failed_audit_write_failed');
    }
  }
}

function hashUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return createHash('sha256').update(userAgent).digest('hex');
}

function friendlyDisplayName(resolvedName: string, email: string): string {
  // OIDC `name` claim is usually the user's full name and works as
  // both Tenant.name and Tenant.displayName for a one-person org. If
  // the IdP didn't send a name (rare), fall back to the local-part
  // of the email so the tenant has SOMETHING readable in the UI.
  const trimmed = resolvedName.trim();
  if (trimmed.length > 0 && !trimmed.includes('@')) return trimmed;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}
