import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../redis/redis.service.js';
import { SignupConfigService } from './signup.config.js';

/**
 * Cloudflare Turnstile siteverify wrapper (ADR-0020 §5).
 *
 * The verified token result is Redis-keyed for 5 minutes per R3 to
 * prevent the double-submit race where two signup requests share one
 * valid token. The verifier returns:
 *
 *   - { ok: true } when siteverify replies `success: true` and Redis
 *     accepts the dedupe insert (NX).
 *   - { ok: false, reason: 'already_used' } when the same token has
 *     already been consumed within the dedupe window — this is the
 *     R3 defence; the controller emits AuthCaptchaFailed with the
 *     `already_used` reason for SIEM correlation.
 *   - { ok: false, reason: 'siteverify_failed', siteverifyErrorCodes }
 *     when Cloudflare's API returns success=false. Codes are
 *     forwarded to the audit row for operator triage (e.g.
 *     `invalid-input-response` vs `bad-request`).
 *   - { ok: false, reason: 'network_error' } on fetch failure /
 *     timeout. Fail-closed (the controller treats this as a refusal).
 *
 * Tokens are sha256-hashed before persisting as dedupe keys — the
 * raw token is short-lived but we still keep it out of Redis logs.
 */

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: 'already_used' }
  | { ok: false; reason: 'siteverify_failed'; siteverifyErrorCodes: string[] }
  | { ok: false; reason: 'network_error' };

interface TurnstileSiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
}

const DEDUPE_PREFIX = 'panorama:signup:turnstile:';
const DEDUPE_TTL_SECONDS = 5 * 60;
const FETCH_TIMEOUT_MS = 5_000;

@Injectable()
export class TurnstileVerifier {
  private readonly log = new Logger('TurnstileVerifier');

  constructor(
    private readonly cfg: SignupConfigService,
    private readonly redis: RedisService,
  ) {}

  async verify(token: string, remoteIp: string | null): Promise<TurnstileResult> {
    if (!token || typeof token !== 'string' || token.length === 0) {
      return {
        ok: false,
        reason: 'siteverify_failed',
        siteverifyErrorCodes: ['missing-input-response'],
      };
    }

    const tokenHash = sha256Hex(token);
    const dedupeKey = DEDUPE_PREFIX + tokenHash;
    let dedupeAccepted = false;
    try {
      // NX + EX in one round-trip: only the first request to present
      // the token wins; subsequent attempts within the window return
      // 'already_used'.
      const result = await this.redis.client.set(
        dedupeKey,
        '1',
        'EX',
        DEDUPE_TTL_SECONDS,
        'NX',
      );
      dedupeAccepted = result === 'OK';
    } catch (err) {
      this.log.warn({ err: String(err) }, 'turnstile_dedupe_redis_error');
      // Fail-closed: an unreachable Redis means we cannot enforce
      // single-use, which downgrades the §5 R3 guarantee. Reject
      // with the network_error reason so the controller treats it
      // as a refusal.
      return { ok: false, reason: 'network_error' };
    }
    if (!dedupeAccepted) {
      return { ok: false, reason: 'already_used' };
    }

    const body = new URLSearchParams();
    body.set('secret', this.cfg.config.turnstileSecret);
    body.set('response', token);
    if (remoteIp) body.set('remoteip', remoteIp);

    let response: Response;
    try {
      response = await fetch(this.cfg.config.turnstileSiteVerifyUrl, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, 'turnstile_fetch_failed');
      // Release the dedupe slot so a retried genuine user isn't
      // locked out by a transient network blip. Best-effort.
      void this.releaseDedupe(dedupeKey);
      return { ok: false, reason: 'network_error' };
    }
    if (!response.ok) {
      this.log.warn(
        { status: response.status },
        'turnstile_siteverify_http_error',
      );
      void this.releaseDedupe(dedupeKey);
      return { ok: false, reason: 'network_error' };
    }
    let parsed: TurnstileSiteverifyResponse;
    try {
      parsed = (await response.json()) as TurnstileSiteverifyResponse;
    } catch (err) {
      this.log.warn({ err: String(err) }, 'turnstile_siteverify_parse_error');
      void this.releaseDedupe(dedupeKey);
      return { ok: false, reason: 'network_error' };
    }
    if (!parsed.success) {
      const codes = Array.isArray(parsed['error-codes']) ? parsed['error-codes'] : [];
      return {
        ok: false,
        reason: 'siteverify_failed',
        siteverifyErrorCodes: codes,
      };
    }
    return { ok: true };
  }

  private async releaseDedupe(dedupeKey: string): Promise<void> {
    try {
      await this.redis.client.del(dedupeKey);
    } catch (err) {
      this.log.debug({ err: String(err) }, 'turnstile_dedupe_release_failed');
    }
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
