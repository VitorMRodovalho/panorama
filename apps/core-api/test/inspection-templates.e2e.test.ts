import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Inspection-template surface (ADR-0012 §Execution-order step 7a).
 *
 * Coverage:
 *   * RBAC: drivers can list/get; only owner / fleet_admin write.
 *   * categoryKind XOR categoryId at create + at PATCH (DB CHECK is
 *     belt; the controller-layer Zod is braces — tested here).
 *   * PATCH replaces items wholesale.
 *   * archive is soft + idempotent.
 *   * RLS cross-tenant isolation — Bravo's admin cannot see Alpha's
 *     templates via the HTTP surface.
 *   * assetId filter resolves to the asset's category.
 *
 * The lifecycle endpoints (start/respond/complete/...) ship in
 * sub-step 7b — out of scope here.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('inspection templates e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenantAlpha: string;
  let tenantBravo: string;
  let alphaVehicleCategoryId: string;
  let alphaAssetId: string;
  const ownerEmail = 'owner.alpha@example.com';
  const driverEmail = 'driver.alpha@example.com';
  const bravoOwnerEmail = 'owner.bravo@example.com';
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const a = await createTenantForTest(admin, {
      slug: 'alpha-insp',
      name: 'Alpha Insp',
      displayName: 'Alpha Insp',
    });
    const b = await createTenantForTest(admin, {
      slug: 'bravo-insp',
      name: 'Bravo Insp',
      displayName: 'Bravo Insp',
    });
    tenantAlpha = a.id;
    tenantBravo = b.id;

    const alphaCategory = await admin.category.create({
      data: { tenantId: a.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    alphaVehicleCategoryId = alphaCategory.id;
    const alphaModel = await admin.assetModel.create({
      data: { tenantId: a.id, categoryId: alphaCategory.id, name: 'F-150' },
    });
    const alphaAsset = await admin.asset.create({
      data: { tenantId: a.id, modelId: alphaModel.id, tag: 'A-1', name: 'Truck A-1' },
    });
    alphaAssetId = alphaAsset.id;

    const ownerAlpha = await admin.user.create({
      data: { email: ownerEmail, displayName: 'Olivia Owner' },
    });
    const driverAlpha = await admin.user.create({
      data: { email: driverEmail, displayName: 'Drew Driver' },
    });
    const ownerBravo = await admin.user.create({
      data: { email: bravoOwnerEmail, displayName: 'Brad Bravo' },
    });
    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: ownerAlpha.id, role: 'owner' },
        { tenantId: a.id, userId: driverAlpha.id, role: 'driver' },
        { tenantId: b.id, userId: ownerBravo.id, role: 'owner' },
      ],
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        {
          userId: ownerAlpha.id,
          provider: 'password',
          subject: ownerEmail,
          emailAtLink: ownerEmail,
          secretHash,
        },
        {
          userId: driverAlpha.id,
          provider: 'password',
          subject: driverEmail,
          emailAtLink: driverEmail,
          secretHash,
        },
        {
          userId: ownerBravo.id,
          provider: 'password',
          subject: bravoOwnerEmail,
          emailAtLink: bravoOwnerEmail,
          secretHash,
        },
      ],
    });
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

  it('GET /inspection-templates without a session returns 401', async () => {
    const res = await fetch(`${url}/inspection-templates`);
    expect(res.status).toBe(401);
  });

  it('driver can list (empty initially)', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/inspection-templates`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('driver cannot create a template (403)', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Driver attempt',
        categoryKind: 'VEHICLE',
        items: [{ label: 'X', itemType: 'BOOLEAN' }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('owner creates a template scoped by categoryKind=VEHICLE', async () => {
    const cookie = await login(url, ownerEmail, password);
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pre-trip — vehicles',
        description: 'DOT pre-trip checklist',
        categoryKind: 'VEHICLE',
        items: [
          { label: 'Lights', itemType: 'BOOLEAN', required: true },
          { label: 'Tires OK?', itemType: 'BOOLEAN', required: true, photoRequired: true },
          { label: 'Mileage', itemType: 'NUMBER', minValue: 0, maxValue: 999_999 },
          { label: 'Notes', itemType: 'TEXT', helpText: 'Anything else?' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      categoryKind: string | null;
      categoryId: string | null;
      items: Array<{ position: number; label: string; itemType: string }>;
    };
    expect(body.name).toBe('Pre-trip — vehicles');
    expect(body.categoryKind).toBe('VEHICLE');
    expect(body.categoryId).toBeNull();
    expect(body.items.length).toBe(4);
    expect(body.items[0]?.position).toBe(0);
    expect(body.items[3]?.label).toBe('Notes');
  });

  it('rejects creating with both categoryKind AND categoryId', async () => {
    const cookie = await login(url, ownerEmail, password);
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad scope',
        categoryKind: 'VEHICLE',
        categoryId: alphaVehicleCategoryId,
        items: [{ label: 'X', itemType: 'BOOLEAN' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects creating with NEITHER categoryKind NOR categoryId', async () => {
    const cookie = await login(url, ownerEmail, password);
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad scope 2',
        items: [{ label: 'X', itemType: 'BOOLEAN' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects creating with > 50 items', async () => {
    const cookie = await login(url, ownerEmail, password);
    const items = Array.from({ length: 51 }, (_, i) => ({
      label: `Item ${i}`,
      itemType: 'BOOLEAN' as const,
    }));
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Too many',
        categoryKind: 'VEHICLE',
        items,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects creating with NUMBER item carrying invalid bounds', async () => {
    const cookie = await login(url, ownerEmail, password);
    const res = await fetch(`${url}/inspection-templates`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad bounds',
        categoryKind: 'VEHICLE',
        items: [{ label: 'X', itemType: 'NUMBER', minValue: 100, maxValue: 50 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH replaces items in one go', async () => {
    const cookie = await login(url, ownerEmail, password);
    // Create a fresh template for this test so item-replace is isolated.
    const created = (await (
      await fetch(`${url}/inspection-templates`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Replace test',
          categoryKind: 'VEHICLE',
          items: [
            { label: 'A', itemType: 'BOOLEAN' },
            { label: 'B', itemType: 'BOOLEAN' },
          ],
        }),
      })
    ).json()) as { id: string };

    const patched = await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { label: 'C', itemType: 'TEXT' },
          { label: 'D', itemType: 'TEXT' },
          { label: 'E', itemType: 'BOOLEAN' },
        ],
      }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      items: Array<{ label: string; position: number }>;
    };
    expect(body.items.map((i) => i.label)).toEqual(['C', 'D', 'E']);
    expect(body.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('listing with assetId resolves to that asset\'s category scope', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(
      `${url}/inspection-templates?assetId=${alphaAssetId}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    // We seeded a VEHICLE-scoped template earlier — driver should see it.
    const names = body.items.map((i) => i.name);
    expect(names).toContain('Pre-trip — vehicles');
  });

  it('archive sets archivedAt, then template is hidden from default list', async () => {
    const cookie = await login(url, ownerEmail, password);
    const created = (await (
      await fetch(`${url}/inspection-templates`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Archive me',
          categoryKind: 'VEHICLE',
          items: [{ label: 'X', itemType: 'BOOLEAN' }],
        }),
      })
    ).json()) as { id: string };

    const del = await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(204);

    const list = (await (
      await fetch(`${url}/inspection-templates`, { headers: { cookie } })
    ).json()) as { items: Array<{ id: string; archivedAt: string | null }> };
    expect(list.items.find((t) => t.id === created.id)).toBeUndefined();

    const listWithArchived = (await (
      await fetch(`${url}/inspection-templates?includeArchived=true`, {
        headers: { cookie },
      })
    ).json()) as { items: Array<{ id: string; archivedAt: string | null }> };
    const arch = listWithArchived.items.find((t) => t.id === created.id);
    expect(arch).toBeDefined();
    expect(arch?.archivedAt).not.toBeNull();
  });

  it('archive is idempotent on already-archived row', async () => {
    const cookie = await login(url, ownerEmail, password);
    const created = (await (
      await fetch(`${url}/inspection-templates`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Idempotent archive',
          categoryKind: 'VEHICLE',
          items: [{ label: 'X', itemType: 'BOOLEAN' }],
        }),
      })
    ).json()) as { id: string };

    const first = await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(first.status).toBe(204);
    const second = await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(second.status).toBe(204);
  });

  it('PATCH on an archived template returns 409', async () => {
    const cookie = await login(url, ownerEmail, password);
    const created = (await (
      await fetch(`${url}/inspection-templates`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Patch-archived',
          categoryKind: 'VEHICLE',
          items: [{ label: 'X', itemType: 'BOOLEAN' }],
        }),
      })
    ).json()) as { id: string };
    await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const patch = await fetch(`${url}/inspection-templates/${created.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Try to revive' }),
    });
    expect(patch.status).toBe(409);
  });

  it('cross-tenant: Bravo owner cannot see Alpha templates', async () => {
    const cookieBravo = await login(url, bravoOwnerEmail, password);
    const list = (await (
      await fetch(`${url}/inspection-templates`, { headers: { cookie: cookieBravo } })
    ).json()) as { items: Array<{ tenantId: string; id: string }> };
    // Every row Bravo's owner sees must be tenantId=tenantBravo. The
    // earlier tests created rows under Alpha; none should appear here.
    for (const t of list.items) {
      expect(t.tenantId).toBe(tenantBravo);
    }
  });

  it('cross-tenant GET by id returns 404 for Bravo on an Alpha template', async () => {
    const cookieAlpha = await login(url, ownerEmail, password);
    const created = (await (
      await fetch(`${url}/inspection-templates`, {
        method: 'POST',
        headers: { cookie: cookieAlpha, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Alpha-only',
          categoryKind: 'VEHICLE',
          items: [{ label: 'X', itemType: 'BOOLEAN' }],
        }),
      })
    ).json()) as { id: string };

    const cookieBravo = await login(url, bravoOwnerEmail, password);
    const res = await fetch(`${url}/inspection-templates/${created.id}`, {
      headers: { cookie: cookieBravo },
    });
    expect(res.status).toBe(404);
  });
});

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const cookie = extractCookie(res);
  if (!cookie) throw new Error('login returned no Set-Cookie header');
  return cookie;
}

function extractCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}
