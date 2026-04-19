import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimitDecision } from '../src/modules/redis/rate-limiter.js';
import type { RateLimiter } from '../src/modules/redis/rate-limiter.js';
import { PhotoUploadRateLimiter } from '../src/modules/photo-pipeline/photo-upload-rate-limiter.js';

/**
 * Bucket isolation + refund behaviour for the photo-upload limiter
 * (ADR-0012 §4). The two-bucket cap (per-user + per-tenant) is what
 * stops one driver from exhausting the whole fleet's hourly quota.
 *
 * Stubs the underlying RateLimiter to make the bucket key + sequence
 * the assertion target — Redis behaviour is already covered in
 * `rate-limiter.test.ts`.
 */
function makeStubLimiter(opts: {
  decisions: Record<string, RateLimitDecision>;
}): { limiter: RateLimiter; consumeCalls: string[]; releaseCalls: string[] } {
  const consumeCalls: string[] = [];
  const releaseCalls: string[] = [];
  const limiter = {
    consume: vi.fn(async (key: string) => {
      consumeCalls.push(key);
      return opts.decisions[key] ?? { allowed: true, remaining: 99, retryAfterSeconds: 0 };
    }),
    release: vi.fn(async (key: string) => {
      releaseCalls.push(key);
    }),
  } as unknown as RateLimiter;
  return { limiter, consumeCalls, releaseCalls };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

describe('PhotoUploadRateLimiter', () => {
  it('charges per-user then per-tenant on a passing request', async () => {
    const { limiter, consumeCalls, releaseCalls } = makeStubLimiter({ decisions: {} });
    const wrapper = new PhotoUploadRateLimiter(limiter);

    const d = await wrapper.check(TENANT, USER);
    expect(d.allowed).toBe(true);
    expect(consumeCalls).toEqual([
      `inspection:photo:upload:user:${TENANT}:${USER}:hour`,
      `inspection:photo:upload:tenant:${TENANT}:hour`,
    ]);
    expect(releaseCalls).toEqual([]);
  });

  it('short-circuits when per-user is over budget — no tenant call', async () => {
    const userKey = `inspection:photo:upload:user:${TENANT}:${USER}:hour`;
    const { limiter, consumeCalls } = makeStubLimiter({
      decisions: {
        [userKey]: { allowed: false, remaining: 0, retryAfterSeconds: 600, reason: 'rate_limited' },
      },
    });
    const wrapper = new PhotoUploadRateLimiter(limiter);

    const d = await wrapper.check(TENANT, USER);
    expect(d.allowed).toBe(false);
    expect(d.bucket).toBe('user');
    expect(d.reason).toBe('rate_limited');
    expect(d.retryAfterSeconds).toBe(600);
    expect(consumeCalls).toEqual([userKey]);
  });

  it('refunds per-user slot when per-tenant denies', async () => {
    const userKey = `inspection:photo:upload:user:${TENANT}:${USER}:hour`;
    const tenantKey = `inspection:photo:upload:tenant:${TENANT}:hour`;
    const { limiter, releaseCalls } = makeStubLimiter({
      decisions: {
        [tenantKey]: { allowed: false, remaining: 0, retryAfterSeconds: 1500, reason: 'rate_limited' },
      },
    });
    const wrapper = new PhotoUploadRateLimiter(limiter);

    const d = await wrapper.check(TENANT, USER);
    expect(d.allowed).toBe(false);
    expect(d.bucket).toBe('tenant');
    expect(d.retryAfterSeconds).toBe(1500);
    // The user's slot must be refunded so their personal quota isn't
    // burned by their tenant hitting the fleet ceiling.
    expect(releaseCalls).toEqual([userKey]);
  });

  it('propagates redis_unavailable as a fail-closed denial', async () => {
    const userKey = `inspection:photo:upload:user:${TENANT}:${USER}:hour`;
    const { limiter } = makeStubLimiter({
      decisions: {
        [userKey]: { allowed: false, remaining: 0, retryAfterSeconds: 1, reason: 'redis_unavailable' },
      },
    });
    const wrapper = new PhotoUploadRateLimiter(limiter);

    const d = await wrapper.check(TENANT, USER);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('redis_unavailable');
    expect(d.bucket).toBe('user');
  });

  it('keys are scoped by tenant + user (no cross-tenant collision)', async () => {
    const { limiter, consumeCalls } = makeStubLimiter({ decisions: {} });
    const wrapper = new PhotoUploadRateLimiter(limiter);

    await wrapper.check(TENANT, USER);
    await wrapper.check('99999999-9999-4999-8999-999999999999', USER);
    // Per-user key carries both tenant + user IDs → tenant-isolation
    // hold even when the same user appears in multiple tenants.
    const userKeys = consumeCalls.filter((k) => k.includes(':user:'));
    expect(new Set(userKeys).size).toBe(2);
  });
});
