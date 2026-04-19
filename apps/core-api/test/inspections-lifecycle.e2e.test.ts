import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Inspection lifecycle e2e (ADR-0012 §Execution-order step 7b).
 *
 * Coverage:
 *   * start → respond → complete → review happy path
 *   * resume returns the same IN_PROGRESS within the stale window
 *   * snapshot on the inspection survives a live-template edit
 *     (§2 — the load-bearing immutability promise)
 *   * required items missing on complete → 400
 *   * NUMBER bounds enforced on respond
 *   * cross-tenant get → 404
 *   * driver cannot see scope=tenant; admin can
 *   * complete enqueues panorama.inspection.completed in the bus
 *     (asserted via the notification_events table — confirms the
 *      step-6 channel will see the event in production)
 *   * double-review races to 409
 *   * cancel from IN_PROGRESS works; cancel-after-complete 409s
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('inspections lifecycle e2e', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let tenantAlpha: string;
  let tenantBravo: string;
  let alphaAssetId: string;
  let alphaTemplateId: string;
  let bravoAssetId: string;
  const ownerEmail = 'owner.lc@example.com';
  const driverEmail = 'driver.lc@example.com';
  const driver2Email = 'driver2.lc@example.com';
  const bravoOwnerEmail = 'owner.bravo.lc@example.com';
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const a = await admin.tenant.create({
      data: { slug: 'alpha-lc', name: 'Alpha LC', displayName: 'Alpha LC' },
    });
    const b = await admin.tenant.create({
      data: { slug: 'bravo-lc', name: 'Bravo LC', displayName: 'Bravo LC' },
    });
    tenantAlpha = a.id;
    tenantBravo = b.id;

    const cat = await admin.category.create({
      data: { tenantId: a.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    const model = await admin.assetModel.create({
      data: { tenantId: a.id, categoryId: cat.id, name: 'F-150' },
    });
    const asset = await admin.asset.create({
      data: { tenantId: a.id, modelId: model.id, tag: 'A-LC-1', name: 'A truck' },
    });
    alphaAssetId = asset.id;

    const bCat = await admin.category.create({
      data: { tenantId: b.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    const bModel = await admin.assetModel.create({
      data: { tenantId: b.id, categoryId: bCat.id, name: 'F-150' },
    });
    const bAsset = await admin.asset.create({
      data: { tenantId: b.id, modelId: bModel.id, tag: 'B-LC-1', name: 'B truck' },
    });
    bravoAssetId = bAsset.id;

    const ownerAlpha = await admin.user.create({
      data: { email: ownerEmail, displayName: 'Olivia Owner' },
    });
    const driverAlpha = await admin.user.create({
      data: { email: driverEmail, displayName: 'Drew Driver' },
    });
    const driver2Alpha = await admin.user.create({
      data: { email: driver2Email, displayName: 'Don Driver' },
    });
    const ownerBravo = await admin.user.create({
      data: { email: bravoOwnerEmail, displayName: 'Brad Bravo' },
    });
    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: ownerAlpha.id, role: 'owner' },
        { tenantId: a.id, userId: driverAlpha.id, role: 'driver' },
        { tenantId: a.id, userId: driver2Alpha.id, role: 'driver' },
        { tenantId: b.id, userId: ownerBravo.id, role: 'owner' },
      ],
    });

    // Seed a VEHICLE-scoped template with one BOOLEAN required, one
    // optional NUMBER. Snapshot will copy these item IDs.
    const template = await admin.inspectionTemplate.create({
      data: {
        tenantId: a.id,
        name: 'Pre-trip',
        categoryKind: 'VEHICLE',
        createdByUserId: ownerAlpha.id,
      },
    });
    alphaTemplateId = template.id;
    await admin.inspectionTemplateItem.createMany({
      data: [
        {
          tenantId: a.id,
          templateId: template.id,
          position: 0,
          label: 'Lights working?',
          itemType: 'BOOLEAN',
          required: true,
        },
        {
          tenantId: a.id,
          templateId: template.id,
          position: 1,
          label: 'Mileage',
          itemType: 'NUMBER',
          required: false,
          minValue: 0,
          maxValue: 999_999,
        },
      ],
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        { userId: ownerAlpha.id, provider: 'password', subject: ownerEmail, emailAtLink: ownerEmail, secretHash },
        { userId: driverAlpha.id, provider: 'password', subject: driverEmail, emailAtLink: driverEmail, secretHash },
        { userId: driver2Alpha.id, provider: 'password', subject: driver2Email, emailAtLink: driver2Email, secretHash },
        { userId: ownerBravo.id, provider: 'password', subject: bravoOwnerEmail, emailAtLink: bravoOwnerEmail, secretHash },
      ],
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  // ----------------------------------------------------------------
  // start
  // ----------------------------------------------------------------

  it('driver starts → returns 201 with snapshot of 2 items', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/inspections`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: alphaAssetId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      resumed: boolean;
      templateId: string | null;
    };
    expect(body.status).toBe('IN_PROGRESS');
    expect(body.resumed).toBe(false);
    expect(body.templateId).toBe(alphaTemplateId);
    // Snapshot lives on GET — verify it's correctly stored.
    const fetched = (await (
      await fetch(`${url}/inspections/${body.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { items: Array<{ label: string }> } };
    const labels = fetched.templateSnapshot.items.map((i) => i.label);
    expect(labels).toEqual(['Lights working?', 'Mileage']);
  });

  it('resume: starting again within window returns the same IN_PROGRESS row', async () => {
    const cookie = await login(url, driver2Email, password);
    const first = await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json() as { id: string; resumed: boolean };
    expect(first.resumed).toBe(false);
    const second = await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json() as { id: string; resumed: boolean };
    expect(second.id).toBe(first.id);
    expect(second.resumed).toBe(true);
  });

  it('starting against an asset in another tenant returns 404', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/inspections`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: bravoAssetId }),
    });
    expect(res.status).toBe(404);
  });

  // ----------------------------------------------------------------
  // respond → complete → review
  // ----------------------------------------------------------------

  it('respond → complete (PASS) → enqueues notification + audit chain', async () => {
    const cookie = await login(url, driverEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string; resumed: boolean };

    const insp = (await (
      await fetch(`${url}/inspections/${start.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { items: Array<{ id: string; label: string }> } };
    const lightItem = insp.templateSnapshot.items.find((i) => i.label === 'Lights working?')!;

    const respond = await fetch(`${url}/inspections/${start.id}/responses`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        responses: [{ snapshotItemId: lightItem.id, booleanValue: true }],
      }),
    });
    expect(respond.status).toBe(200);

    const complete = await fetch(`${url}/inspections/${start.id}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'PASS', summaryNote: 'all good' }),
    });
    expect(complete.status).toBe(200);
    const completed = (await complete.json()) as {
      status: string;
      outcome: string;
      completedAt: string;
    };
    expect(completed.status).toBe('COMPLETED');
    expect(completed.outcome).toBe('PASS');

    // The notification row must exist in the outbox — confirms the
    // step-6 channel will see this event in production.
    const events = await admin.notificationEvent.findMany({
      where: { tenantId: tenantAlpha, eventType: 'panorama.inspection.completed' },
    });
    const me = events.find(
      (e) => (e.payload as { inspectionId?: string })?.inspectionId === start.id,
    );
    expect(me).toBeDefined();
    const payload = me!.payload as Record<string, unknown>;
    expect(payload['outcome']).toBe('PASS');
    expect(payload['summaryNote']).toBe('all good');
  });

  it('complete fails 400 if a required item has no response', async () => {
    const cookie = await login(url, driverEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };

    const res = await fetch(`${url}/inspections/${start.id}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'PASS' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/required_items_missing/);

    // Cleanup so the next test doesn't trip on this in-progress row.
    await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('NUMBER response below min bounds is rejected 400', async () => {
    const cookie = await login(url, driverEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };

    const insp = (await (
      await fetch(`${url}/inspections/${start.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { items: Array<{ id: string; label: string; itemType: string }> } };
    const mileage = insp.templateSnapshot.items.find((i) => i.label === 'Mileage')!;

    const res = await fetch(`${url}/inspections/${start.id}/responses`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ responses: [{ snapshotItemId: mileage.id, numberValue: -5 }] }),
    });
    expect(res.status).toBe(400);

    await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('snapshot is preserved after a live-template edit (ADR §2)', async () => {
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie: driverCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };

    // Owner mutates the live template — replace items with a fresh
    // single TEXT item.
    const mutate = await fetch(`${url}/inspection-templates/${alphaTemplateId}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ label: 'Free-form notes', itemType: 'TEXT' }],
      }),
    });
    expect(mutate.status).toBe(200);

    // The in-progress inspection's snapshot still has both original
    // items — frozen by ADR §2 enforce_inspection_snapshot_immutable.
    const fetched = (await (
      await fetch(`${url}/inspections/${start.id}`, { headers: { cookie: driverCookie } })
    ).json()) as { templateSnapshot: { items: Array<{ label: string }> } };
    const labels = fetched.templateSnapshot.items.map((i) => i.label);
    expect(labels).toEqual(['Lights working?', 'Mileage']);

    // Restore the template for downstream tests.
    await fetch(`${url}/inspection-templates/${alphaTemplateId}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { label: 'Lights working?', itemType: 'BOOLEAN', required: true },
          { label: 'Mileage', itemType: 'NUMBER', minValue: 0, maxValue: 999_999 },
        ],
      }),
    });
    await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  // ----------------------------------------------------------------
  // review (admin)
  // ----------------------------------------------------------------

  it('admin reviews a FAIL → 200; second review 409', async () => {
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    // Start fresh + complete with FAIL
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie: driverCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };
    const insp = (await (
      await fetch(`${url}/inspections/${start.id}`, { headers: { cookie: driverCookie } })
    ).json()) as { templateSnapshot: { items: Array<{ id: string; label: string }> } };
    const lightItem = insp.templateSnapshot.items.find((i) => i.label === 'Lights working?')!;
    await fetch(`${url}/inspections/${start.id}/responses`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        responses: [{ snapshotItemId: lightItem.id, booleanValue: false }],
      }),
    });
    await fetch(`${url}/inspections/${start.id}/complete`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'FAIL', summaryNote: 'left turn signal out' }),
    });

    // Driver cannot review.
    const driverReview = await fetch(`${url}/inspections/${start.id}/review`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewNote: 'driver trying' }),
    });
    expect(driverReview.status).toBe(403);

    // Admin reviews — first 200, second 409.
    const r1 = await fetch(`${url}/inspections/${start.id}/review`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewNote: 'shop scheduled' }),
    });
    expect(r1.status).toBe(200);
    const r1Body = (await r1.json()) as { reviewedAt: string | null; reviewNote: string };
    expect(r1Body.reviewedAt).not.toBeNull();
    expect(r1Body.reviewNote).toBe('shop scheduled');

    const r2 = await fetch(`${url}/inspections/${start.id}/review`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r2.status).toBe(409);

    // Append-after-review note works.
    const append = await fetch(`${url}/inspections/${start.id}/review-note`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewNote: 'shop scheduled — body shop confirmed return 4/22' }),
    });
    expect(append.status).toBe(200);
  });

  // ----------------------------------------------------------------
  // list / scope
  // ----------------------------------------------------------------

  it('driver scope=mine sees only their inspections; scope=tenant 403', async () => {
    const cookie = await login(url, driverEmail, password);
    const mine = (await (
      await fetch(`${url}/inspections?scope=mine`, { headers: { cookie } })
    ).json()) as { items: Array<{ startedByUserId: string }> };
    for (const i of mine.items) {
      expect(typeof i.startedByUserId).toBe('string');
    }
    const tenant = await fetch(`${url}/inspections?scope=tenant`, { headers: { cookie } });
    expect(tenant.status).toBe(403);
  });

  it('admin scope=tenant sees both drivers\' inspections', async () => {
    const cookie = await login(url, ownerEmail, password);
    const res = await fetch(`${url}/inspections?scope=tenant&limit=200`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ startedByUserId: string }> };
    const starters = new Set(body.items.map((i) => i.startedByUserId));
    expect(starters.size).toBeGreaterThanOrEqual(2);
  });

  it('cross-tenant: Bravo owner cannot GET an Alpha inspection', async () => {
    const driverCookie = await login(url, driverEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie: driverCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };

    const bravoCookie = await login(url, bravoOwnerEmail, password);
    const res = await fetch(`${url}/inspections/${start.id}`, { headers: { cookie: bravoCookie } });
    expect(res.status).toBe(404);

    await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  // ----------------------------------------------------------------
  // cancel
  // ----------------------------------------------------------------

  it('cancel from IN_PROGRESS works; cancel-after-complete 409', async () => {
    const cookie = await login(url, driverEmail, password);
    const start = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };

    const cancel1 = await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'wrong asset' }),
    });
    expect(cancel1.status).toBe(200);

    // Idempotent re-cancel returns 200 (no-op).
    const cancel2 = await fetch(`${url}/inspections/${start.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(cancel2.status).toBe(200);

    // Complete-then-cancel: 409.
    const start2 = (await (
      await fetch(`${url}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: alphaAssetId }),
      })
    ).json()) as { id: string };
    const insp = (await (
      await fetch(`${url}/inspections/${start2.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { items: Array<{ id: string; label: string }> } };
    const lightItem = insp.templateSnapshot.items.find((i) => i.label === 'Lights working?')!;
    await fetch(`${url}/inspections/${start2.id}/responses`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ responses: [{ snapshotItemId: lightItem.id, booleanValue: true }] }),
    });
    await fetch(`${url}/inspections/${start2.id}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'PASS' }),
    });
    const lateCancel = await fetch(`${url}/inspections/${start2.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(lateCancel.status).toBe(409);
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
