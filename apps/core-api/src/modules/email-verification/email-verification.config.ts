import { Injectable } from '@nestjs/common';

/**
 * ADR-0020 §3 — email-verification surface configuration.
 *
 * `EMAIL_VERIFICATION_TTL_HOURS` (default 24h) bounds how long a
 * minted token stays consumable. Self-hosters can shorten if their
 * threat model demands.
 *
 * `verifyUrlBase` is the absolute prefix the email body links to —
 * defaults to `${APP_BASE_URL}/auth/verify`. The link itself is a
 * GET (so email clients can render it) but the page at that URL is
 * expected to forward the token to the backend via POST per §3
 * (defeats Outlook Safe-Links / Slack unfurl pre-consumption of
 * one-time tokens). The frontend implementation of that page is
 * apps/web work; backend ships the endpoint + the email body.
 */
export interface EmailVerificationConfig {
  ttlHours: number;
  verifyUrlBase: string;
  /**
   * Same shape and env knob as `SignupConfigService.failureLatencyFloorMs`
   * — reused here so the verify endpoint shares the §5 timing-padded
   * 400 envelope without a cross-module dependency cycle
   * (SignupModule → EmailVerificationModule and back). Default 600ms.
   */
  failureLatencyFloorMs: number;
}

@Injectable()
export class EmailVerificationConfigService {
  readonly config: EmailVerificationConfig;

  constructor() {
    const ttlRaw = process.env['EMAIL_VERIFICATION_TTL_HOURS'];
    const ttlHours = ttlRaw ? Number(ttlRaw) : 24;
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
      throw new Error(
        `EMAIL_VERIFICATION_TTL_HOURS must be a positive number ≤168; got ${JSON.stringify(ttlRaw)}`,
      );
    }
    const floorRaw = process.env['SIGNUP_FAILURE_LATENCY_FLOOR_MS'];
    const failureLatencyFloorMs = floorRaw ? Number(floorRaw) : 600;
    if (!Number.isFinite(failureLatencyFloorMs) || failureLatencyFloorMs < 0) {
      throw new Error(
        `SIGNUP_FAILURE_LATENCY_FLOOR_MS must be a non-negative number; got ${JSON.stringify(floorRaw)}`,
      );
    }
    const baseUrl = (process.env['APP_BASE_URL'] ?? 'http://localhost:4000')
      .replace(/\/+$/, '')
      .toLowerCase();
    this.config = {
      ttlHours,
      verifyUrlBase: `${baseUrl}/auth/verify`,
      failureLatencyFloorMs,
    };
  }
}
