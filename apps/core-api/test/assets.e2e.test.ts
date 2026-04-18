import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';

/**
 * End-to-end: boots the full Nest application and hits /assets + /health
 * through Node's fetch client. Proves that:
 *
 *   - the app starts with every module wired
 *   - /health is reachable without a tenant
 *   - /assets without X-Tenant-Id returns 401
 *   - /assets with X-Tenant-Id=alpha returns only alpha rows
 *   - /assets with X-Tenant-Id=bravo returns only bravo rows
 *   - the Prisma middleware + Postgres RLS cooperate under a real HTTP
 *     request (not just direct DB calls)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('assets e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenantAlpha: string;
  let tenantBravo: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

    // Seed deterministic fixtures via the super-admin role (bypass RLS).
    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.reservation.deleteMany();
    await admin.asset.deleteMany();
    await admin.assetModel.deleteMany();
    await admin.manufacturer.deleteMany();
    await admin.category.deleteMany();
    await admin.tenantMembership.deleteMany();
    await admin.authIdentity.deleteMany();
    await admin.user.deleteMany();
    await admin.tenant.deleteMany();

    const a = await admin.tenant.create({
      data: { slug: 'alpha-e2e', name: 'Alpha e2e', displayName: 'Alpha e2e' },
    });
    const b = await admin.tenant.create({
      data: { slug: 'bravo-e2e', name: 'Bravo e2e', displayName: 'Bravo e2e' },
    });
    tenantAlpha = a.id;
    tenantBravo = b.id;

    for (const [tenantId, tagPrefix] of [
      [a.id, 'A'],
      [b.id, 'B'],
    ] as const) {
      const category = await admin.category.create({
        data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
      });
      const model = await admin.assetModel.create({
        data: { tenantId, categoryId: category.id, name: 'F-150' },
      });
      await admin.asset.createMany({
        data: [1, 2].map((i) => ({
          tenantId,
          modelId: model.id,
          tag: `${tagPrefix}-${i}`,
          name: `${tagPrefix} truck ${i}`,
        })),
      });
    }
    await admin.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health returns ok with db up', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe('up');
  });

  it('GET /assets without X-Tenant-Id returns 401', async () => {
    const res = await fetch(`${url}/assets`);
    expect(res.status).toBe(401);
  });

  it('GET /assets as alpha returns only alpha rows', async () => {
    const res = await fetch(`${url}/assets`, {
      headers: { 'X-Tenant-Id': tenantAlpha },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ tag: string }> };
    const tags = body.items.map((i) => i.tag).sort();
    expect(tags).toEqual(['A-1', 'A-2']);
  });

  it('GET /assets as bravo returns only bravo rows', async () => {
    const res = await fetch(`${url}/assets`, {
      headers: { 'X-Tenant-Id': tenantBravo },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ tag: string }> };
    const tags = body.items.map((i) => i.tag).sort();
    expect(tags).toEqual(['B-1', 'B-2']);
  });

  it('GET /assets with an invalid tenant UUID returns 401', async () => {
    const res = await fetch(`${url}/assets`, {
      headers: { 'X-Tenant-Id': 'not-a-uuid' },
    });
    expect(res.status).toBe(401);
  });
});
