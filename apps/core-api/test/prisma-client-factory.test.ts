import { describe, it, expect } from 'vitest';
import {
  PRISMA_V6_POOL_DEFAULTS,
  createPgAdapter,
  pgAdapterSettingsFromUrl,
} from '../src/modules/prisma/prisma-client.factory.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';

/**
 * Prisma 7 driver-adapter wiring (no database needed). Locks in the
 * pool settings that keep Prisma 6 behaviour and the translation of
 * the Prisma 6 URL parameters that `pg` would otherwise ignore.
 */

// The adapter keeps the pg.Pool config it will build the pool from;
// read it back to assert what the pool is created with.
function poolConfigOf(url: string): Record<string, unknown> {
  return (createPgAdapter(url) as unknown as { config: Record<string, unknown> }).config;
}

describe('prisma client factory', () => {
  it('pins the Prisma 6 connect and idle timeouts on every pool', () => {
    const cfg = poolConfigOf('postgres://u:p@localhost:5432/db');
    expect(cfg['connectionTimeoutMillis']).toBe(5_000);
    expect(cfg['idleTimeoutMillis']).toBe(300_000);
    expect(PRISMA_V6_POOL_DEFAULTS).toEqual({
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 300_000,
    });
  });

  it('passes the connection string through unchanged', () => {
    const url = 'postgres://u:p@localhost:5432/db?schema=public&sslmode=disable';
    expect(poolConfigOf(url)['connectionString']).toBe(url);
  });

  it('maps connection_limit to the pg pool size', () => {
    expect(pgAdapterSettingsFromUrl('postgres://u:p@h/db?connection_limit=7')).toEqual({ max: 7 });
    expect(poolConfigOf('postgres://u:p@h/db?connection_limit=7')['max']).toBe(7);
  });

  it('leaves the pool size at the pg default without connection_limit', () => {
    expect(poolConfigOf('postgres://u:p@h/db')).not.toHaveProperty('max');
  });

  it('rejects a connection_limit that is not a positive integer', () => {
    for (const bad of ['0', '-1', '2.5', 'ten', '']) {
      expect(() =>
        pgAdapterSettingsFromUrl(`postgres://u:p@h/db?connection_limit=${bad}`),
      ).toThrow(/connection_limit/);
    }
  });

  it('never echoes the URL (credentials) in the connection_limit error', () => {
    let message = '';
    try {
      pgAdapterSettingsFromUrl('postgres://user:s3cret@h/db?connection_limit=x');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/connection_limit/);
    expect(message).not.toContain('s3cret');
  });

  it('maps schema to the adapter schema option', () => {
    expect(pgAdapterSettingsFromUrl('postgres://u:p@h/db?schema=public')).toEqual({
      schema: 'public',
    });
    expect(pgAdapterSettingsFromUrl('postgres://u:p@h/db')).toEqual({});
  });

  it('ignores Prisma 6 parameters that have no Prisma 7 meaning', () => {
    expect(
      pgAdapterSettingsFromUrl('postgres://u:p@h/db?pgbouncer=true&pool_timeout=10&connect_timeout=5'),
    ).toEqual({});
  });

  it('returns no settings for a string URL cannot parse (pg reports it on connect)', () => {
    expect(pgAdapterSettingsFromUrl('not a url')).toEqual({});
  });
});

describe('PrismaService construction (Prisma 7)', () => {
  it('refuses to build the appClient without a connection string', () => {
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(() => new PrismaService()).toThrow(/DATABASE_URL is not set/);
    } finally {
      if (saved !== undefined) process.env['DATABASE_URL'] = saved;
    }
  });

  it('builds without connecting when given a URL', async () => {
    // PrismaClient's constructor returns a proxy, so `instanceof` and
    // pretty-printing the instance are not meaningful; assert the
    // service surface instead.
    const svc = new PrismaService({ datasourceUrl: 'postgres://u:p@127.0.0.1:1/db' });
    expect(typeof svc.runInTenant).toBe('function');
    expect(typeof svc.runAsSuperAdmin).toBe('function');
    await svc.$disconnect();
  });
});
