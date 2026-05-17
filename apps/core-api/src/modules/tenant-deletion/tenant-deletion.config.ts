import { Injectable } from '@nestjs/common';

/**
 * ADR-0020 §7 — tenant deletion cool-off configuration.
 *
 * `coolOffDays` (default 7) bounds the wait between
 * `delete-confirm` and the cron purge. Self-hosters can shorten
 * for staging convenience or lengthen for compliance.
 *
 * `tokenTtlHours` (default 24h) bounds how long a delete-request
 * confirmation token stays consumable. The window is the time an
 * Owner has to react to the request-email; missing the window
 * cleanly invalidates the request without escalating.
 *
 * `manageUrlBase` is the absolute prefix the email body links to
 * for the confirm / cancel pages —
 * `${APP_BASE_URL}/tenants/:tenantId/deletion`. The token rides in
 * the URL fragment (#token=...) so link-preview bots cannot
 * pre-consume; the frontend forwards via POST.
 *
 * `failureLatencyFloorMs` mirrors the `SIGNUP_FAILURE_LATENCY_FLOOR_MS`
 * env knob from SignupConfigService / EmailVerificationConfigService —
 * same shape, same env knob, kept in-module to avoid a circular
 * import.
 */
export interface TenantDeletionConfig {
  coolOffDays: number;
  tokenTtlHours: number;
  manageUrlBase: string;
  failureLatencyFloorMs: number;
}

@Injectable()
export class TenantDeletionConfigService {
  readonly config: TenantDeletionConfig;

  constructor() {
    const coolOffRaw = process.env['TENANT_DELETE_COOL_OFF_DAYS'];
    const coolOffDays = coolOffRaw ? Number(coolOffRaw) : 7;
    if (!Number.isFinite(coolOffDays) || coolOffDays <= 0 || coolOffDays > 30) {
      throw new Error(
        `TENANT_DELETE_COOL_OFF_DAYS must be a positive number ≤30; got ${JSON.stringify(coolOffRaw)}`,
      );
    }
    const ttlRaw = process.env['TENANT_DELETE_TOKEN_TTL_HOURS'];
    const tokenTtlHours = ttlRaw ? Number(ttlRaw) : 24;
    if (!Number.isFinite(tokenTtlHours) || tokenTtlHours <= 0 || tokenTtlHours > 168) {
      throw new Error(
        `TENANT_DELETE_TOKEN_TTL_HOURS must be a positive number ≤168; got ${JSON.stringify(ttlRaw)}`,
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
      coolOffDays,
      tokenTtlHours,
      manageUrlBase: baseUrl,
      failureLatencyFloorMs,
    };
  }
}
