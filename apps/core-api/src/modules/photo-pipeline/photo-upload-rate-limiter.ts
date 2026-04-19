import { Injectable, Logger } from '@nestjs/common';
import { RateLimiter } from '../redis/rate-limiter.js';

/**
 * Photo-upload caps (ADR-0012 §4) on top of the generic Redis
 * sliding-window limiter.
 *
 * Two buckets, both fail-CLOSED on Redis outage (inherited from the
 * underlying `RateLimiter`):
 *
 *   * per-user   — 20 uploads / hour. Mirrors the per-inspection cap.
 *   * per-tenant — 200 uploads / hour. Multi-driver fleet ceiling.
 *
 * Both buckets are charged on a successful pre-check. If the per-user
 * bucket passes but the per-tenant bucket then fails, the per-user
 * slot is released (best-effort; a leaked slot is preferable to a
 * leaked tenant cap).
 *
 * The `@Throttle` decorator stays on the controller as an
 * in-memory belt — that one is per-IP-and-process, this one is
 * cluster-wide and authoritative.
 */
export type PhotoRateBucket = 'user' | 'tenant';

export interface PhotoUploadRateDecision {
  allowed: boolean;
  /** Which bucket capped the request (when not allowed). */
  bucket?: PhotoRateBucket;
  remainingUser: number;
  remainingTenant: number;
  retryAfterSeconds: number;
  reason?: 'rate_limited' | 'redis_unavailable';
}

const PER_USER_LIMIT = 20;
const PER_TENANT_LIMIT = 200;
const WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class PhotoUploadRateLimiter {
  private readonly log = new Logger('PhotoUploadRateLimiter');

  constructor(private readonly limiter: RateLimiter) {}

  async check(tenantId: string, userId: string): Promise<PhotoUploadRateDecision> {
    const userKey = bucketKey('user', tenantId, userId);
    const tenantKey = bucketKey('tenant', tenantId);

    const userDecision = await this.limiter.consume(userKey, PER_USER_LIMIT, WINDOW_MS);
    if (!userDecision.allowed) {
      const base: PhotoUploadRateDecision = {
        allowed: false,
        bucket: 'user',
        remainingUser: 0,
        remainingTenant: -1,
        retryAfterSeconds: userDecision.retryAfterSeconds,
      };
      return userDecision.reason ? { ...base, reason: userDecision.reason } : base;
    }

    const tenantDecision = await this.limiter.consume(
      tenantKey,
      PER_TENANT_LIMIT,
      WINDOW_MS,
    );
    if (!tenantDecision.allowed) {
      // Per-tenant denied AFTER per-user already charged. Best-effort
      // refund so the user isn't double-billed by their tenant's cap.
      // Caveat (`rate-limiter.ts:84-93`): `release` removes the newest
      // member of the user-bucket sorted set; under same-user
      // concurrency a sibling slot can be refunded instead of ours.
      // Bounded to one user, audit-irrelevant — accepted trade.
      await this.limiter.release(userKey, PER_USER_LIMIT, WINDOW_MS);
      const base: PhotoUploadRateDecision = {
        allowed: false,
        bucket: 'tenant',
        remainingUser: userDecision.remaining,
        remainingTenant: 0,
        retryAfterSeconds: tenantDecision.retryAfterSeconds,
      };
      return tenantDecision.reason ? { ...base, reason: tenantDecision.reason } : base;
    }

    return {
      allowed: true,
      remainingUser: userDecision.remaining,
      remainingTenant: tenantDecision.remaining,
      retryAfterSeconds: 0,
    };
  }

}

function bucketKey(bucket: PhotoRateBucket, tenantId: string, userId?: string): string {
  return bucket === 'user'
    ? `inspection:photo:upload:user:${tenantId}:${userId}:hour`
    : `inspection:photo:upload:tenant:${tenantId}:hour`;
}
