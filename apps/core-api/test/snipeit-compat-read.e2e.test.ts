import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { PersonalAccessTokenService } from '../src/modules/auth/personal-access-token.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Snipe-IT compat shim read endpoints (ADR-0010 steps 6 + 7).
 *
 * Covers the subset SnipeScheduler-FleetManager/src/snipeit_client.php
 * actually reads. Every test authenticates via Bearer PAT — no session
 * cookies — mimicking a real FleetManager deploy pointing
 * `$snipeBaseUrl` at Panorama.
 *
 * Shape assertions mirror the keys FleetManager's php code reads
 * (`rows`, `total`, `asset_tag`, `requestable`, `status_label`,
 * `model.id`, `category.name`, `vip`, `category_type`, …) — see the
 * client source for the exact surface.
 *
 * Also carries the ADR-mandated negative: a PAT replayed against
 * /invitations returns 401, NOT silent-fallback 200.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('snipeit compat read endpoints e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let patPlaintext: string;
  let tenantId: string;
  let adminUserId: string;
  let otherTenantId: string;
  let assetIds: string[] = [];
  let categoryId: string;
  let modelId: string;

  const admin = {
    email: 'admin@shim-read.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Shim Read Admin',
  };

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${patPlaintext}` };
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    const passwords = new PasswordService();
    const adminUser = await adminDb.user.create({
      data: { email: admin.email, displayName: admin.displayName, firstName: 'Shim', lastName: 'Admin' },
    });
    adminUserId = adminUser.id;
    await adminDb.authIdentity.create({
      data: {
        userId: adminUser.id,
        provider: 'password',
        subject: admin.email,
        emailAtLink: admin.email,
        secretHash: await passwords.hash(admin.password),
      },
    });

    const tenants = app.get(TenantAdminService);
    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'shim-read',
      name: 'Shim Read',
      displayName: 'Shim Read',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.update({
      where: { tenantId_userId: { tenantId, userId: adminUser.id } },
      data: { isVip: true },
    });

    // Seed fleet.
    const category = await adminDb.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    categoryId = category.id;
    const manufacturer = await adminDb.manufacturer.create({
      data: { tenantId, name: 'Ford' },
    });
    const model = await adminDb.assetModel.create({
      data: {
        tenantId,
        categoryId: category.id,
        manufacturerId: manufacturer.id,
        name: 'F-150 2024',
        modelNumber: 'F150-24',
      },
    });
    modelId = model.id;
    for (let i = 1; i <= 3; i++) {
      const asset = await adminDb.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `SH-${String(i).padStart(2, '0')}`,
          name: `Shim Truck ${i}`,
          serial: `SN-${1000 + i}`,
          bookable: i !== 2, // second truck not bookable, to test requestable filter
          status: i === 3 ? 'MAINTENANCE' : 'READY',
        },
      });
      assetIds.push(asset.id);
    }

    // Seed a second tenant so we can prove isolation — a PAT in
    // tenant A must not see rows from tenant B.
    const otherUser = await adminDb.user.create({
      data: { email: 'other@shim-read.example', displayName: 'Other' },
    });
    const other = await tenants.createTenantWithOwner({
      slug: 'shim-read-other',
      name: 'Shim Read Other',
      displayName: 'Shim Read Other',
      ownerUserId: otherUser.id,
    });
    otherTenantId = other.tenant.id;
    const otherCategory = await adminDb.category.create({
      data: { tenantId: otherTenantId, name: 'Other Vehicles', kind: 'VEHICLE' },
    });
    const otherModel = await adminDb.assetModel.create({
      data: {
        tenantId: otherTenantId,
        categoryId: otherCategory.id,
        name: 'Cross-Tenant Model',
      },
    });
    await adminDb.asset.create({
      data: {
        tenantId: otherTenantId,
        modelId: otherModel.id,
        tag: 'CROSS-01',
        name: 'Cross-Tenant Truck',
        bookable: true,
        status: 'READY',
      },
    });

    // Mint a PAT for the admin.
    const pats = app.get(PersonalAccessTokenService);
    const { plaintext } = await pats.mint({
      actor: { userId: adminUser.id, tenantId },
      name: 'shim-read-fixture',
      scopes: ['snipeit.compat.read'],
    });
    patPlaintext = plaintext;
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // ---- hardware -----------------------------------------------------

  it('GET /api/v1/hardware returns { rows, total } with Snipe-IT asset shape', async () => {
    const res = await fetch(`${url}/api/v1/hardware`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        name: string;
        asset_tag: string;
        serial: string | null;
        status_label: { id: null; name: string; status_type: string };
        requestable: boolean;
        model: { id: string; name: string } | null;
        category: { id: string; name: string } | null;
        manufacturer: { id: string; name: string } | null;
      }>;
      total: number;
    };
    expect(body.total).toBe(3); // our tenant only; cross-tenant truck excluded
    expect(body.rows).toHaveLength(3);
    const first = body.rows.find((r) => r.asset_tag === 'SH-01')!;
    expect(first).toBeDefined();
    expect(first.name).toBe('Shim Truck 1');
    expect(first.serial).toBe('SN-1001');
    expect(first.requestable).toBe(true);
    expect(first.status_label.status_type).toBe('deployable');
    expect(first.model).toEqual({ id: modelId, name: 'F-150 2024' });
    expect(first.category).toEqual({ id: categoryId, name: 'Vehicles' });
    expect(first.manufacturer?.name).toBe('Ford');
  });

  it('GET /api/v1/hardware?requestable=1 filters to bookable-only', async () => {
    const res = await fetch(`${url}/api/v1/hardware?requestable=1`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ asset_tag: string }>; total: number };
    expect(body.total).toBe(2); // SH-01 + SH-03 (SH-02 not bookable)
    const tags = body.rows.map((r) => r.asset_tag).sort();
    expect(tags).toEqual(['SH-01', 'SH-03']);
  });

  it('GET /api/v1/hardware?search=SH-02 matches asset_tag substring', async () => {
    const res = await fetch(`${url}/api/v1/hardware?search=SH-02`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ asset_tag: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows[0]!.asset_tag).toBe('SH-02');
  });

  it('GET /api/v1/hardware?limit=2&offset=1 paginates', async () => {
    const res = await fetch(`${url}/api/v1/hardware?limit=2&offset=1`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(2);
  });

  it('GET /api/v1/hardware/:id returns a single asset — cross-tenant lookup returns 404', async () => {
    const ok = await fetch(`${url}/api/v1/hardware/${assetIds[0]}`, { headers: authHeaders() });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { id: string; asset_tag: string };
    expect(body.id).toBe(assetIds[0]);
    expect(body.asset_tag).toBe('SH-01');

    // Cross-tenant asset — RLS must return 404 via runInTenant filter.
    const crossTenantAsset = await adminDb.asset.findFirst({
      where: { tenantId: otherTenantId },
    });
    expect(crossTenantAsset).toBeTruthy();
    const notFound = await fetch(`${url}/api/v1/hardware/${crossTenantAsset!.id}`, {
      headers: authHeaders(),
    });
    expect(notFound.status).toBe(404);
  });

  // ---- users --------------------------------------------------------

  it('GET /api/v1/users returns the tenant roster with vip + email + name shape', async () => {
    const res = await fetch(`${url}/api/v1/users`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        name: string;
        username: string;
        vip: boolean;
      }>;
      total: number;
    };
    expect(body.total).toBe(1); // just the admin, marked VIP in fixture
    const u = body.rows[0]!;
    expect(u.email).toBe(admin.email);
    expect(u.first_name).toBe('Shim');
    expect(u.last_name).toBe('Admin');
    expect(u.name).toBe(admin.displayName);
    expect(u.vip).toBe(true);
    expect(u.username).toBe(admin.email);
  });

  it('GET /api/v1/users?search=<email> matches', async () => {
    const res = await fetch(
      `${url}/api/v1/users?search=${encodeURIComponent(admin.email)}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it('GET /api/v1/users/:id returns the user; cross-tenant user 404', async () => {
    const ok = await fetch(`${url}/api/v1/users/${adminUserId}`, { headers: authHeaders() });
    expect(ok.status).toBe(200);

    const otherUser = await adminDb.user.findFirst({
      where: { email: 'other@shim-read.example' },
    });
    const notFound = await fetch(`${url}/api/v1/users/${otherUser!.id}`, {
      headers: authHeaders(),
    });
    expect(notFound.status).toBe(404);
  });

  // ---- categories ---------------------------------------------------

  it('GET /api/v1/categories returns tenant-only with category_type', async () => {
    const res = await fetch(`${url}/api/v1/categories`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; name: string; category_type: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.rows[0]!.name).toBe('Vehicles');
    expect(body.rows[0]!.category_type).toBe('asset');
  });

  // ---- models -------------------------------------------------------

  it('GET /api/v1/models returns requestable flag derived from bookable-asset count', async () => {
    const res = await fetch(`${url}/api/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        name: string;
        requestable: boolean;
        category: { id: string; name: string } | null;
        manufacturer: { id: string; name: string } | null;
      }>;
      total: number;
    };
    expect(body.total).toBe(1);
    const m = body.rows[0]!;
    expect(m.name).toBe('F-150 2024');
    // Two bookable assets exist (SH-01, SH-03) → requestable=true.
    expect(m.requestable).toBe(true);
    expect(m.category?.name).toBe('Vehicles');
    expect(m.manufacturer?.name).toBe('Ford');
  });

  it('GET /api/v1/models?category_id=<uuid> filters to category', async () => {
    const res = await fetch(`${url}/api/v1/models?category_id=${categoryId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('GET /api/v1/models/:id returns a single model; unknown id 404', async () => {
    const ok = await fetch(`${url}/api/v1/models/${modelId}`, { headers: authHeaders() });
    expect(ok.status).toBe(200);
    const nope = await fetch(`${url}/api/v1/models/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders(),
    });
    expect(nope.status).toBe(404);
  });

  // ---- module boundary (the ADR's headline invariant) ---------------

  it('PAT replayed against /invitations (native) → 401, never silent fallback', async () => {
    const res = await fetch(`${url}/invitations`, { headers: authHeaders() });
    expect(res.status).toBe(401);
  });

  it('PAT replayed against /reservations (native) → 401', async () => {
    const res = await fetch(`${url}/reservations`, { headers: authHeaders() });
    expect(res.status).toBe(401);
  });

  // ---- validation ---------------------------------------------------

  it('rejects limit out of range', async () => {
    const res = await fetch(`${url}/api/v1/hardware?limit=999`, { headers: authHeaders() });
    expect(res.status).toBe(400);
  });
});
