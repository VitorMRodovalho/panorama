import { Injectable, Logger } from '@nestjs/common';

/**
 * Self-serve OIDC signup configuration (ADR-0020 §1, §4, §5).
 *
 * Read once at boot so the rest of the module doesn't keep poking
 * `process.env`. The flag itself (`FEATURE_SELF_SERVE_SIGNUP`) gates
 * registration of `SignupModule` in `app.module.ts`; this service is
 * only instantiated when the flag is on, so `enabled` would be
 * tautologically true here. We keep the field anyway because the
 * boot-audit + signup-flood test both observe it.
 *
 * `TURNSTILE_SECRET` is required when the flag is on; bootstrap
 * refuses to start otherwise so an operator cannot accidentally
 * deploy a signup endpoint without the CAPTCHA backstop.
 *
 * `TURNSTILE_SITE_VERIFY_URL` defaults to Cloudflare's production
 * endpoint and exists only to redirect to an in-process stub during
 * e2e tests (mirrors the `OIDC_ALLOW_INSECURE_ISSUER` escape hatch
 * shape in `auth.config.ts`). Never override in production.
 */
export interface SignupConfig {
  enabled: boolean;
  turnstileSecret: string;
  turnstileSiteVerifyUrl: string;
  /**
   * Minimum response latency for every failure path (rate-limit trip,
   * CAPTCHA failure, OIDC refused, state mismatch). ADR-0020 §5 fixes
   * the floor at 600ms calibrated to the 95th-percentile success
   * latency. Configurable for tests that need to assert the floor was
   * applied without paying 600ms per request.
   */
  failureLatencyFloorMs: number;
}

@Injectable()
export class SignupConfigService {
  private readonly log = new Logger('SignupConfig');
  readonly config: SignupConfig;

  constructor() {
    const enabled = readBoolEnv('FEATURE_SELF_SERVE_SIGNUP', false);
    const turnstileSecret = process.env['TURNSTILE_SECRET'] ?? '';
    if (enabled && turnstileSecret.length === 0) {
      throw new Error(
        'TURNSTILE_SECRET must be set when FEATURE_SELF_SERVE_SIGNUP=true. ' +
          'Get one at https://dash.cloudflare.com/?to=/:account/turnstile.',
      );
    }
    const turnstileSiteVerifyUrl =
      process.env['TURNSTILE_SITE_VERIFY_URL'] ??
      'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const floorRaw = process.env['SIGNUP_FAILURE_LATENCY_FLOOR_MS'];
    const failureLatencyFloorMs = floorRaw ? Number(floorRaw) : 600;
    if (!Number.isFinite(failureLatencyFloorMs) || failureLatencyFloorMs < 0) {
      throw new Error(
        `SIGNUP_FAILURE_LATENCY_FLOOR_MS must be a non-negative number; got ${JSON.stringify(floorRaw)}`,
      );
    }
    this.config = {
      enabled,
      turnstileSecret,
      turnstileSiteVerifyUrl,
      failureLatencyFloorMs,
    };
    if (enabled) {
      this.log.log(
        { failureLatencyFloorMs },
        'signup_module_enabled',
      );
    }
  }
}

function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? '').toLowerCase();
  if (raw === '') return defaultValue;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}
