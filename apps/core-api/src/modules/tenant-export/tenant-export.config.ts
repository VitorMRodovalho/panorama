import { Injectable } from '@nestjs/common';

/**
 * ADR-0020 §8 — tenant-data export configuration.
 *
 * Two TTL knobs, intentionally split (security-reviewer PR 4
 * BLOCKER 3 — middlebox-prefetch threat):
 *
 *   - `windowSeconds` (default 86400 = 24h, floor 300s = 5min,
 *     cap 86400s = 24h) — how long the JOB stays downloadable
 *     after `completedAt`. The completion email's Panorama-link
 *     stops resolving past this window; the tenant_exports row's
 *     `expiresAt` records the boundary.
 *
 *   - `downloadUrlTtlSeconds` (constant, 60s) — the TTL on the
 *     short-lived presigned S3 URL minted by the session-gated
 *     `/tenants/:tenantId/exports/:jobId/download` endpoint. The
 *     URL is only ever exposed for the 302 redirect that follows
 *     a valid Owner session GET; it never crosses email, never
 *     enters mail-scanner caches, and never appears in audit
 *     metadata.
 *
 * `manageUrlBase` is the Panorama public URL prefix (defaults to
 * `APP_BASE_URL`) — the email body links to
 * `${manageUrlBase}/tenants/:tenantId/exports/:jobId/download`,
 * which 302s through the session check. Mail-scanners that
 * prefetch the URL hit 401 (no session) and cache that, not the
 * file.
 *
 * `failureLatencyFloorMs` mirrors `SIGNUP_FAILURE_LATENCY_FLOOR_MS`.
 */
export interface TenantExportConfig {
  windowSeconds: number;
  /** Constant: 60s. Short-lived S3 URL for the 302 redirect only. */
  downloadUrlTtlSeconds: number;
  manageUrlBase: string;
  failureLatencyFloorMs: number;
}

const WINDOW_FLOOR = 5 * 60;
const WINDOW_CEILING = 24 * 60 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 60;

@Injectable()
export class TenantExportConfigService {
  readonly config: TenantExportConfig;

  constructor() {
    const ttlRaw = process.env['TENANT_EXPORT_WINDOW_SECONDS'];
    const windowSeconds = ttlRaw ? Number(ttlRaw) : WINDOW_CEILING;
    if (
      !Number.isInteger(windowSeconds) ||
      windowSeconds < WINDOW_FLOOR ||
      windowSeconds > WINDOW_CEILING
    ) {
      throw new Error(
        `TENANT_EXPORT_WINDOW_SECONDS must be an integer in [${WINDOW_FLOOR}, ${WINDOW_CEILING}]; got ${JSON.stringify(ttlRaw)}`,
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
      windowSeconds,
      downloadUrlTtlSeconds: DOWNLOAD_URL_TTL_SECONDS,
      manageUrlBase: baseUrl,
      failureLatencyFloorMs,
    };
  }
}
