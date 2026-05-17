import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { EmailVerificationService } from './email-verification.service.js';
import { EmailVerificationConfigService } from './email-verification.config.js';
import { SignupRateLimits } from '../signup/signup-rate-limits.service.js';
import { respondTimingPadded } from '../signup/signup-failure.helper.js';
import { getRequestSession } from '../auth/session.middleware.js';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';

/**
 * ADR-0020 §3 — POST /auth/verify.
 *
 * Token comes in the request body. The email link uses a URL FRAGMENT
 * (`#token=...`) so the token never reaches the server / proxies /
 * referers / inline scan logs; the frontend at `${verifyUrlBase}`
 * reads `location.hash`, strips it, and POSTs the value here.
 *
 * Every failure path returns the same timing-padded 400 envelope as
 * the signup endpoints (`{ error: 'signup_failed' }`, status 400 not
 * 429) so an external attacker cannot distinguish missing /
 * expired / already-consumed / rate-limited from each other purely
 * by wall-clock. The shared `signup_failed` envelope is intentional:
 * an enumerator can't tell whether `/auth/verify` even exists vs
 * `/auth/signup/.../start` from the response shape alone.
 *
 * Rate-limit: shares the §4 per-IP + per-subnet buckets with the
 * signup-initiate / signup-callback surfaces. Same threat actor
 * (anonymous IP), same budget. Trip emits `AuthVerifyRefused` with
 * the matching reason so SIEM can distinguish verify-flood from
 * signup-flood. The §3 per-email cap does NOT apply here — the cap
 * gates DISPATCH, not consume.
 *
 * Logged-out-only: a verify POST arriving with an authenticated
 * session is a confused-deputy attempt (a logged-in user clicking
 * a stray verify link from another tenant); refuse with
 * `AuthVerifyRefused(reason='session_attached')`.
 *
 * Unlike SignupController, this endpoint is loaded UNCONDITIONALLY
 * — even with `FEATURE_SELF_SERVE_SIGNUP=false`, a tenant created
 * while the flag was on may still need the verify path. The
 * endpoint refuses gracefully when no matching token exists.
 */

const VerifyBodySchema = z.object({
  token: z.string().min(1).max(1024),
});

@Controller('auth')
export class EmailVerificationController {
  private readonly log = new Logger('EmailVerificationController');

  constructor(
    private readonly verifier: EmailVerificationService,
    private readonly cfg: EmailVerificationConfigService,
    private readonly limits: SignupRateLimits,
    private readonly audit: AuditService,
  ) {}

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const startedAt = Date.now();

    // §3-derived rate-limits FIRST — bound any pre-validation audit-
    // emit flood. Mirrors the SignupController contract.
    const ipDecision = await this.limits.consumeIp(req.ip);
    if (!ipDecision.allowed) {
      await this.recordRefused('rate_limit_ip', req.ip ?? null);
      return respondTimingPadded(
        res,
        startedAt,
        this.cfg.config.failureLatencyFloorMs,
      );
    }
    const subnetDecision = await this.limits.consumeSubnet(req.ip);
    if (!subnetDecision.allowed) {
      await this.recordRefused('rate_limit_subnet', req.ip ?? null);
      return respondTimingPadded(
        res,
        startedAt,
        this.cfg.config.failureLatencyFloorMs,
      );
    }

    // §1a-parallel: verify is logged-out-only. A logged-in user
    // POSTing a stray token from another tenant would otherwise
    // flip that tenant's pendingVerification (the consume path
    // doesn't check session).
    if (getRequestSession(req)) {
      await this.recordRefused('session_attached', null);
      return respondTimingPadded(
        res,
        startedAt,
        this.cfg.config.failureLatencyFloorMs,
      );
    }

    const parsed = VerifyBodySchema.safeParse(body);
    if (!parsed.success) {
      return respondTimingPadded(
        res,
        startedAt,
        this.cfg.config.failureLatencyFloorMs,
      );
    }

    const result = await this.verifier.consume(parsed.data.token);

    if (result.kind === 'ok') {
      // Success — tenant is now verified. The browser can now sign in
      // through the standard /auth/oidc/:provider/start flow; the
      // session-build path will see `pendingVerification=false` and
      // mint a session. We do NOT mint the session here because the
      // verify endpoint is OIDC-agnostic (the user submits a token,
      // not an OIDC token), and reusing the signup callback's stored
      // codeVerifier would require coupling the two surfaces.
      res.status(200).json({ ok: true });
      return;
    }

    // All four failure shapes share the same response envelope.
    // The specific reason is logged + (could be audited in a future
    // PR — see security-reviewer R-item on emitting for
    // `already_consumed` and verified-`expired`) but never surfaced
    // to the client.
    this.log.warn({ reason: result.kind }, 'verify_failed');
    return respondTimingPadded(
      res,
      startedAt,
      this.cfg.config.failureLatencyFloorMs,
    );
  }

  private async recordRefused(
    reason: 'session_attached' | 'rate_limit_ip' | 'rate_limit_subnet',
    keyMaterial: string | null,
  ): Promise<void> {
    try {
      const metadata: Record<string, unknown> = { reason };
      if (keyMaterial !== null) {
        metadata['keyHash'] = createHash('sha256')
          .update(keyMaterial)
          .digest('hex')
          .slice(0, 16);
      }
      await this.audit.record({
        action: PanoramaAuditAction.AuthVerifyRefused,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata,
      });
    } catch (err) {
      this.log.error({ err: String(err) }, 'verify_refused_audit_write_failed');
    }
  }
}
