import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/modules/redis/rate-limiter.js';
import type { RedisService } from '../src/modules/redis/redis.service.js';

/**
 * Unit coverage for the sliding-window limiter's two critical
 * behaviours:
 *
 *   * happy path: allow until the window is full, then reject with a
 *     sensible retryAfter
 *   * fail-CLOSED: any Redis error (connection refused, timeout,
 *     malformed response) returns `allowed: false` with
 *     `reason='redis_unavailable'`. This is the deliberate ADR-0008
 *     trade — temporarily cap to zero beats an uncapped invitation
 *     blast when the limiter is down.
 */

class StubPipeline {
  constructor(private readonly results: Array<[Error | null, unknown]> | null) {}
  zremrangebyscore(): this { return this; }
  zadd(): this { return this; }
  zcard(): this { return this; }
  pexpire(): this { return this; }
  async exec(): Promise<Array<[Error | null, unknown]> | null> {
    return this.results;
  }
}

function makeRedis(opts: {
  multiReturns?: Array<[Error | null, unknown]> | null;
  multiThrows?: boolean;
  zrange?: string[];
}): RedisService {
  const client = {
    multi(): StubPipeline {
      if (opts.multiThrows) throw new Error('ECONNREFUSED');
      // `multiReturns` is only falsy-by-design when the test wants
      // exec() to resolve to null. Keep `undefined` → [] (the default)
      // but treat explicit `null` as "return null".
      const results = opts.multiReturns === undefined ? [] : opts.multiReturns;
      return new StubPipeline(results);
    },
    async zrange(): Promise<string[]> {
      return opts.zrange ?? [];
    },
    async zrem(): Promise<number> {
      return 1;
    },
  };
  return { client } as unknown as RedisService;
}

describe('RateLimiter', () => {
  it('fails CLOSED when the pipeline throws (ADR-0008)', async () => {
    const limiter = new RateLimiter(makeRedis({ multiThrows: true }));
    const d = await limiter.consume('k', 10, 60_000);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('redis_unavailable');
  });

  it('fails CLOSED when exec() returns null (connection dropped mid-pipeline)', async () => {
    const limiter = new RateLimiter(makeRedis({ multiReturns: null }));
    const d = await limiter.consume('k', 10, 60_000);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('redis_unavailable');
  });

  it('fails CLOSED when the count reply is non-numeric', async () => {
    const limiter = new RateLimiter(
      makeRedis({
        multiReturns: [
          [null, 0],
          [null, 1],
          [null, 'not-a-number'],
          [null, 1],
        ],
      }),
    );
    const d = await limiter.consume('k', 10, 60_000);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('redis_unavailable');
  });

  it('allows traffic under the limit', async () => {
    const limiter = new RateLimiter(
      makeRedis({
        multiReturns: [
          [null, 0],
          [null, 1],
          [null, 5],
          [null, 1],
        ],
      }),
    );
    const d = await limiter.consume('k', 10, 60_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(5);
  });

  it('rejects over-limit traffic with a retryAfter', async () => {
    const now = Date.now();
    const limiter = new RateLimiter(
      makeRedis({
        multiReturns: [
          [null, 0],
          [null, 1],
          [null, 11],
          [null, 1],
        ],
        zrange: [`${now - 30_000}`, `${now - 30_000}`],
      }),
    );
    const d = await limiter.consume('k', 10, 60_000);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('rate_limited');
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });
});
