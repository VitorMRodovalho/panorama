import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import type { Request } from 'express';
import { PerTenantThrottlerGuard } from '../src/shared/throttler/per-tenant-throttler.guard.js';
import { runInContext } from '../src/modules/tenant/tenant.context.js';

/**
 * Tracker keys of the global APP_GUARD.
 *
 * Since @nestjs/throttler 6.7.0 the base guard masks IPv6 sources to a
 * /64 before keying, so one client cannot rotate addresses inside its
 * own allocation to get a fresh bucket per request. The per-tenant
 * guard overrides `getTracker`, so it only gets that behaviour by
 * delegating its IP part to `super.getTracker`. These cases pin it.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

class ExposedGuard extends PerTenantThrottlerGuard {
  tracker(req: Request): Promise<string> {
    return this.getTracker(req);
  }
}

async function makeGuard(options: { ipv6SubnetPrefix?: number } = {}): Promise<ExposedGuard> {
  // getTracker never touches storage; the stub only satisfies the ctor.
  const storage = {} as ThrottlerStorage;
  const moduleOptions: ThrottlerModuleOptions = {
    throttlers: [{ name: 'global', ttl: 60_000, limit: 120 }],
    ...options,
  };
  const guard = new ExposedGuard(moduleOptions, storage, new Reflector());
  // onModuleInit is where the base guard reads `ipv6SubnetPrefix`.
  await guard.onModuleInit();
  return guard;
}

function req(ip: string | undefined): Request {
  return { ip } as Request;
}

function anonymous<T>(fn: () => Promise<T>): Promise<T> {
  return runInContext(
    { tenantId: null, userId: null, actorEmail: null, requestId: 'req_test' },
    fn,
  ) as Promise<T>;
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInContext(
    { tenantId: TENANT, userId: 'u1', actorEmail: null, requestId: 'req_test' },
    fn,
  ) as Promise<T>;
}

describe('PerTenantThrottlerGuard tracker', () => {
  it('keys anonymous IPv4 requests by the address itself', async () => {
    const guard = await makeGuard();
    await expect(anonymous(() => guard.tracker(req('203.0.113.7')))).resolves.toBe('203.0.113.7');
  });

  it('keys authenticated requests by tenant and address', async () => {
    const guard = await makeGuard();
    await expect(inTenant(() => guard.tracker(req('203.0.113.7')))).resolves.toBe(
      `${TENANT}:203.0.113.7`,
    );
  });

  it('puts two addresses from the same IPv6 /64 in one bucket', async () => {
    const guard = await makeGuard();
    const a = await anonymous(() => guard.tracker(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd')));
    const b = await anonymous(() => guard.tracker(req('2001:db8:1:2::1')));
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    // A different /64 is a different bucket.
    const c = await anonymous(() => guard.tracker(req('2001:db8:1:3::1')));
    expect(c).not.toBe(a);
  });

  it('keeps the tenant prefix on a masked IPv6 tracker', async () => {
    const guard = await makeGuard();
    await expect(inTenant(() => guard.tracker(req('2001:db8:1:2::abcd')))).resolves.toBe(
      `${TENANT}:2001:db8:1:2::/64`,
    );
  });

  it('honours the ipv6SubnetPrefix module option', async () => {
    const guard = await makeGuard({ ipv6SubnetPrefix: 48 });
    await expect(anonymous(() => guard.tracker(req('2001:db8:1:2::1')))).resolves.toBe(
      '2001:db8:1::/48',
    );
  });

  it('unwraps IPv4-mapped IPv6 to the IPv4 address', async () => {
    const guard = await makeGuard();
    await expect(anonymous(() => guard.tracker(req('::ffff:203.0.113.7')))).resolves.toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the shared "unknown" bucket when req.ip is missing', async () => {
    const guard = await makeGuard();
    await expect(anonymous(() => guard.tracker(req(undefined)))).resolves.toBe('unknown');
    await expect(inTenant(() => guard.tracker(req('')))).resolves.toBe(`${TENANT}:unknown`);
  });
});
