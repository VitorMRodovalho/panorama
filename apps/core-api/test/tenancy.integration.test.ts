import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetTestDb } from './_reset-db.js';

/**
 * Integration test proving that Postgres RLS + Prisma enforce tenant
 * isolation end-to-end.
 *
 * Requires:
 *   * Postgres is up with the 0001_core_schema migration and rls.sql applied
 *   * Roles `panorama_app` (NOBYPASSRLS) and `panorama_super_admin` (BYPASSRLS)
 *     exist and have the grants from rls.sql
 *
 * What we prove:
 *   1. With `panorama.current_tenant = A`, panorama_app sees only tenant-A rows
 *   2. Switching to `panorama.current_tenant = B`, panorama_app sees only tenant-B rows
 *   3. With no GUC set, panorama_app sees zero rows (deny-by-default)
 *   4. panorama_super_admin bypasses RLS and sees everything
 *   5. A cross-tenant write attempt (GUC=A but data.tenantId=B) is rejected
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB   = process.env.PG_DB   ?? 'panorama';

const APP_URL   = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('tenant isolation (Prisma middleware + Postgres RLS)', () => {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const app   = new PrismaClient({ datasources: { db: { url: APP_URL } } });

  let tenantA: string;
  let tenantB: string;
  let modelA: string;
  let modelB: string;

  beforeAll(async () => {
    // Clean slate — admin bypasses RLS so we can purge cross-tenant safely.
    await resetTestDb(admin);

    const a = await admin.tenant.create({
      data: { slug: 'tenant-a', name: 'Tenant A', displayName: 'A' },
    });
    const b = await admin.tenant.create({
      data: { slug: 'tenant-b', name: 'Tenant B', displayName: 'B' },
    });
    tenantA = a.id;
    tenantB = b.id;

    const catA = await admin.category.create({
      data: { tenantId: tenantA, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const catB = await admin.category.create({
      data: { tenantId: tenantB, name: 'Vehicles', kind: 'VEHICLE' },
    });

    const mA = await admin.assetModel.create({
      data: { tenantId: tenantA, categoryId: catA.id, name: 'Ford F-150' },
    });
    const mB = await admin.assetModel.create({
      data: { tenantId: tenantB, categoryId: catB.id, name: 'Ford F-150' },
    });
    modelA = mA.id;
    modelB = mB.id;

    await admin.asset.create({
      data: { tenantId: tenantA, modelId: modelA, tag: 'A-1', name: 'Tenant A truck 1' },
    });
    await admin.asset.create({
      data: { tenantId: tenantB, modelId: modelB, tag: 'B-1', name: 'Tenant B truck 1' },
    });
  });

  afterAll(async () => {
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('app role sees only tenant A when panorama.current_tenant = A', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantA}'`);
      return tx.asset.findMany({ select: { tag: true, tenantId: true } });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tag).toBe('A-1');
    expect(rows[0]?.tenantId).toBe(tenantA);
  });

  it('app role sees only tenant B when panorama.current_tenant = B', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantB}'`);
      return tx.asset.findMany({ select: { tag: true, tenantId: true } });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tag).toBe('B-1');
    expect(rows[0]?.tenantId).toBe(tenantB);
  });

  it('app role sees zero rows when panorama.current_tenant is unset', async () => {
    const rows = await app.$transaction(async (tx) => {
      return tx.asset.findMany();
    });
    expect(rows).toHaveLength(0);
  });

  it('super admin bypasses RLS and sees all tenants', async () => {
    const rows = await admin.asset.findMany({ select: { tag: true } });
    const tags = rows.map((r) => r.tag).sort();
    expect(tags).toEqual(['A-1', 'B-1']);
  });

  it('cross-tenant write is rejected even when GUC is set', async () => {
    // GUC says tenant A, but we try to insert a row that claims tenantId = B.
    // RLS WITH CHECK must refuse the write.
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantA}'`);
        return tx.asset.create({
          data: {
            tenantId: tenantB,
            modelId: modelB,
            tag: 'malicious-cross-tenant',
            name: 'should never land',
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('tenants table is self-scoped — app sees only its own tenant', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantA}'`);
      return tx.tenant.findMany();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(tenantA);
  });
});
