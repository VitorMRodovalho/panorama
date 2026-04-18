import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * Read-through cache for TenantMembership.status lookups from
 * `PatAuthGuard`. 30s TTL per (userId, tenantId) key (ADR-0010).
 *
 * Explicit invalidation is ADR-mandated: the consumer contract is
 * that a membership status change via the service layer flips the
 * cached value to null so the next PAT call re-reads from the DB
 * and picks up the new state.
 *
 * Direct DB edits (psql session, migrations) bypass invalidation —
 * their staleness window is bounded by the TTL.
 */
export type MembershipCacheStatus = 'active' | 'suspended' | 'not_a_member';

const TTL_MS = 30_000;

@Injectable()
export class PatMembershipCache {
  private readonly log = new Logger('PatMembershipCache');

  constructor(private readonly redis: RedisService) {}

  private key(userId: string, tenantId: string): string {
    return `pat:membership:${userId}:${tenantId}`;
  }

  /**
   * Returns the cached status, or null if:
   *   * the key isn't in Redis;
   *   * the key holds a value we don't recognise (cache corruption
   *     — treat as miss);
   *   * Redis is unreachable (caller must decide fail-open vs fail-
   *     closed — the PatAuthGuard fails closed).
   *
   * Throws ONLY on programmer error. Redis transport errors become a
   * `null` return + a warning log.
   */
  async get(userId: string, tenantId: string): Promise<MembershipCacheStatus | null | 'unavailable'> {
    try {
      const cached = await this.redis.client.get(this.key(userId, tenantId));
      if (cached === 'active' || cached === 'suspended' || cached === 'not_a_member') {
        return cached;
      }
      return null;
    } catch (err) {
      this.log.warn({ err: String(err), userId, tenantId }, 'pat_membership_cache_read_failed');
      return 'unavailable';
    }
  }

  async set(
    userId: string,
    tenantId: string,
    status: MembershipCacheStatus,
  ): Promise<void> {
    try {
      await this.redis.client.set(this.key(userId, tenantId), status, 'PX', TTL_MS);
    } catch (err) {
      this.log.warn({ err: String(err), userId, tenantId }, 'pat_membership_cache_write_failed');
    }
  }

  /**
   * Drop the cached value. Called from every TenantMembership write
   * path so a role / status change is picked up within one PAT call.
   * Best-effort — a Redis blip leaves the key in place until its TTL
   * expires, which is the documented staleness ceiling.
   */
  async invalidate(userId: string, tenantId: string): Promise<void> {
    try {
      await this.redis.client.del(this.key(userId, tenantId));
    } catch (err) {
      this.log.warn({ err: String(err), userId, tenantId }, 'pat_membership_cache_invalidate_failed');
    }
  }
}
