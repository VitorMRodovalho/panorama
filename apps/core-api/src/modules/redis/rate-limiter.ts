import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Sliding-window rate limiter backed by a Redis sorted set.
 *
 * Pattern: for each bucket key, ZADD with score = now, ZREMRANGEBYSCORE
 * drops entries older than the window, then ZCARD counts what's left.
 * Exceeding `limit` refuses the request. A short TTL on the key makes
 * idle buckets auto-expire.
 *
 * **Fails closed** (ADR-0008 §Rate limits): any Redis error — connection
 * refused, timeout, malformed response — is converted to `allowed:
 * false` with reason=`redis_unavailable`. A temporary loss of the
 * limiter is preferable to an uncapped invitation blast.
 */
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  reason?: 'rate_limited' | 'redis_unavailable';
}

@Injectable()
export class RateLimiter {
  private readonly log = new Logger('RateLimiter');

  constructor(private readonly redis: RedisService) {}

  /**
   * Consume a slot on a sliding window. Adds a new hit and returns the
   * current count's relationship to the limit.
   *
   * @param key     Namespaced bucket key (e.g. `invite:admin:<uuid>:hour`).
   * @param limit   Max allowed events in the window.
   * @param windowMs  Window length in milliseconds.
   */
  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const cutoff = now - windowMs;

    try {
      const pipeline = this.redis.client.multi();
      pipeline.zremrangebyscore(key, 0, cutoff);
      pipeline.zadd(key, now, member);
      pipeline.zcard(key);
      // TTL = window + 60s so the key self-cleans but survives fleeting races
      pipeline.pexpire(key, windowMs + 60_000);
      const result = await pipeline.exec();
      if (!result) {
        return { allowed: false, remaining: 0, retryAfterSeconds: 1, reason: 'redis_unavailable' };
      }
      const countReply = result[2]?.[1];
      const count = typeof countReply === 'number' ? countReply : Number(countReply ?? 0);
      if (!Number.isFinite(count)) {
        return { allowed: false, remaining: 0, retryAfterSeconds: 1, reason: 'redis_unavailable' };
      }
      if (count <= limit) {
        return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
      }
      // Over budget: return the oldest member's age to compute retry-after.
      const oldest = await this.redis.client.zrange(key, 0, 0, 'WITHSCORES');
      const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now - windowMs;
      const retryAfterMs = Math.max(0, oldestScore + windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        reason: 'rate_limited',
      };
    } catch (err) {
      this.log.warn({ key, err: String(err) }, 'rate_limiter_failed_closed');
      return { allowed: false, remaining: 0, retryAfterSeconds: 1, reason: 'redis_unavailable' };
    }
  }

  /**
   * Remove an earlier-consumed slot. Used when the downstream operation
   * was aborted post-consume (e.g. the invitation DB write raced against
   * the partial unique index). Best-effort; errors are swallowed because
   * the worst case is a temporarily-tighter quota.
   */
  async release(key: string, limit: number, windowMs: number): Promise<void> {
    try {
      const members = await this.redis.client.zrange(key, -1, -1);
      if (members.length > 0) {
        await this.redis.client.zrem(key, members[0]!);
      }
    } catch (err) {
      this.log.debug({ key, err: String(err), limit, windowMs }, 'rate_limiter_release_failed');
    }
  }
}
