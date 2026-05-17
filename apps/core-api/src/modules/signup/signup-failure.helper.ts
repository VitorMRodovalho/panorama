import { BadRequestException, Logger } from '@nestjs/common';
import type { Response } from 'express';

const log = new Logger('SignupFailure');

/**
 * Constant-latency 400 envelope for every signup failure path
 * (ADR-0020 §5).
 *
 * Rate-limit rejection is sub-millisecond (Redis local). Turnstile
 * verification is 50-300ms (HTTPS to Cloudflare). OIDC token
 * validation is 100-500ms (HTTPS to Google/Microsoft). An attacker
 * timing failure paths can distinguish them purely by wall-clock,
 * defeating §5's no-leak goal — so EVERY failure response is padded
 * to the configured floor (default 600ms, calibrated to the 95th
 * percentile success-path latency).
 *
 * All failures share:
 *   - Response envelope `{ error: 'signup_failed' }` (no detail)
 *   - Status 400 (NOT 429 — 429 would leak the rate-limit's
 *     existence to an anonymous attacker; this is a deliberate
 *     deviation from /auth/login which DOES return 429 because the
 *     audience there is authenticated users for whom 429 carries
 *     operational value).
 *   - Same latency floor (padded async, do not block on real work).
 *
 * The audit row the controller emits BEFORE calling this helper
 * still carries the distinct reason (`rate_limit_tripped`,
 * `captcha_failed`, `oidc_state_mismatch`, ...) so SIEM can
 * distinguish failure shapes for incident response — the leak is
 * only closed from the *attacker's* side.
 *
 * `respond` is preferred over throwing because Nest's exception
 * filter writes the response before the awaited delay can elapse;
 * we set the status + body explicitly and await the timer. The
 * controller `return`s the awaited result so the request handler
 * resolves only after the floor has been reached.
 */

const ENVELOPE = { error: 'signup_failed' } as const;

export async function respondTimingPadded(
  res: Response,
  startedAt: number,
  floorMs: number,
): Promise<void> {
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, floorMs - elapsed);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
  if (res.headersSent) {
    // Reaching the failure path AFTER headers were already flushed is
    // an upstream-control-flow bug — most likely a missing `return`
    // before a fall-through into another respond/redirect, or a
    // socket-level write from a middleware that bypassed Nest. The
    // wall-clock floor is moot at this point (the client already saw
    // a response shape), but the leak it guards against deserves a
    // loud breadcrumb so an audit-log search lands on the offending
    // request.
    log.warn(
      { elapsedMs: elapsed, floorMs },
      'signup_failure_after_headers_sent',
    );
    return;
  }
  res.status(400).json(ENVELOPE);
}

/**
 * Throw helper for places where setting the status directly isn't
 * convenient (validation pipes, decorators that fire pre-response).
 * The exception filter sees `BadRequestException(ENVELOPE)` and
 * writes the same shape — though the timing-floor cannot be applied
 * to a synchronous throw, so prefer `respondTimingPadded` whenever
 * the failure path runs inside the controller body.
 */
export function throwSignupFailed(): never {
  throw new BadRequestException(ENVELOPE);
}
