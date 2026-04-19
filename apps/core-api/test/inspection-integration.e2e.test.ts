import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { InspectionMaintenanceService } from '../src/modules/inspection/inspection-maintenance.service.js';
import { ObjectStorageService } from '../src/modules/object-storage/object-storage.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Cross-cutting integration tests — ADR-0012 §Execution-order step 10.
 *
 * Each test exercises a hardening rule that lives in a different
 * layer of the stack and would slip through if any one layer
 * regressed:
 *
 *   1. Cross-tenant photo block at the RLS layer (the load-bearing one
 *      per ADR §5 — service assertion + key prefix + DB CHECK are
 *      additional belts, but this test pins the FIRST defence by
 *      driving Prisma directly with a bogus tenant GUC and asserting
 *      zero rows return).
 *   2. DB CHECK on `inspection_photos.storageKey` rejects a key that
 *      doesn't match the UUID-strict regex (mirrors the
 *      `assertKeyForTenant` regex; both must stay in lock-step).
 *   3. Template precedence (categoryId > categoryKind per ADR §1) on
 *      the launcher start path.
 *   4. `panorama.inspection.photo.viewed` dedup-per-minute — second
 *      detail view within 60 s emits NO new audit row; switching to
 *      list view DOES emit because the dedup key includes viewKind.
 *   5. Retention sweep removes the S3 object too — direct HEAD on
 *      the bucket returns 404.
 *
 * Tests that already live in feature-specific suites are NOT
 * duplicated here:
 *   - cross-tenant 404 at the HTTP service layer       → photos.e2e
 *   - assertKeyForTenant + regex round-trip            → object-storage
 *   - snapshot preserved across live edit              → lifecycle
 *   - resume-in-progress same id                       → lifecycle
 *   - tether on/off                                    → tether.e2e
 *   - stale auto-cancel                                → maintenance.e2e
 *   - retention sweep DB row + audit                   → maintenance.e2e
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('inspection cross-cutting integration e2e (step 10)', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  // Same DB but using the panorama_app role — NOBYPASSRLS, so the GUC
  // path is the only way to see tenant-scoped rows.
  let asApp: PrismaClient;
  let maintenance: InspectionMaintenanceService;
  let storage: ObjectStorageService;

  let tenantA: string;
  let tenantB: string;
  let assetA: string;
  let categoryAVehicleId: string;
  let templateAByKind: string;
  let templateAById: string;
  let driverEmail: string;
  let bravoDriverEmail: string;
  const ownerEmail = 'owner.int@example.com';
  const password = 'correct-horse-battery-staple';

  let plainJpeg: Buffer;

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    const minioCheck = await fetch('http://localhost:9000/minio/health/live').catch(() => null);
    if (!minioCheck || minioCheck.status !== 200) {
      throw new Error('MinIO not reachable at http://localhost:9000');
    }

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    asApp = new PrismaClient({ datasources: { db: { url: APP_URL } } });
    await resetTestDb(admin);

    const a = await createTenantForTest(admin, {
      slug: 'alpha-int',
      name: 'Alpha Int',
      displayName: 'Alpha Int',
    });
    const b = await createTenantForTest(admin, {
      slug: 'bravo-int',
      name: 'Bravo Int',
      displayName: 'Bravo Int',
    });
    tenantA = a.id;
    tenantB = b.id;

    const aCat = await admin.category.create({
      data: { tenantId: a.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    categoryAVehicleId = aCat.id;
    const aModel = await admin.assetModel.create({
      data: { tenantId: a.id, categoryId: aCat.id, name: 'F-150' },
    });
    const aAsset = await admin.asset.create({
      data: { tenantId: a.id, modelId: aModel.id, tag: 'A-INT-1', name: 'A truck', bookable: true, status: 'READY' },
    });
    assetA = aAsset.id;

    const bCat = await admin.category.create({
      data: { tenantId: b.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    const bModel = await admin.assetModel.create({
      data: { tenantId: b.id, categoryId: bCat.id, name: 'F-150' },
    });
    await admin.asset.create({
      data: { tenantId: b.id, modelId: bModel.id, tag: 'B-INT-1', name: 'B truck', bookable: true, status: 'READY' },
    });

    ownerEmail;
    driverEmail = 'driver.int@example.com';
    bravoDriverEmail = 'driver.bravo.int@example.com';

    const ownerA = await admin.user.create({
      data: { email: ownerEmail, displayName: 'Olivia Owner' },
    });
    const driverA = await admin.user.create({
      data: { email: driverEmail, displayName: 'Drew Driver' },
    });
    const bravoDriver = await admin.user.create({
      data: { email: bravoDriverEmail, displayName: 'Brad Bravo' },
    });
    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: ownerA.id, role: 'owner' },
        { tenantId: a.id, userId: driverA.id, role: 'driver' },
        { tenantId: b.id, userId: bravoDriver.id, role: 'driver' },
      ],
    });

    // Two templates in tenant A: one scoped categoryKind=VEHICLE,
    // one scoped categoryId on the same VEHICLE category. ADR §1
    // launcher resolution: categoryId beats categoryKind. Differ by
    // name so the test asserts which one was snapshotted.
    templateAByKind = (
      await admin.inspectionTemplate.create({
        data: {
          tenantId: a.id,
          name: 'Generic VEHICLE template',
          categoryKind: 'VEHICLE',
          createdByUserId: ownerA.id,
        },
      })
    ).id;
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: a.id,
        templateId: templateAByKind,
        position: 0,
        label: 'Generic check',
        itemType: 'BOOLEAN',
      },
    });
    templateAById = (
      await admin.inspectionTemplate.create({
        data: {
          tenantId: a.id,
          name: 'Trucks-specific template',
          categoryId: categoryAVehicleId,
          createdByUserId: ownerA.id,
        },
      })
    ).id;
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: a.id,
        templateId: templateAById,
        position: 0,
        label: 'Trucks-specific check',
        itemType: 'BOOLEAN',
      },
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        { userId: ownerA.id, provider: 'password', subject: ownerEmail, emailAtLink: ownerEmail, secretHash },
        { userId: driverA.id, provider: 'password', subject: driverEmail, emailAtLink: driverEmail, secretHash },
        { userId: bravoDriver.id, provider: 'password', subject: bravoDriverEmail, emailAtLink: bravoDriverEmail, secretHash },
      ],
    });

    plainJpeg = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .toBuffer();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
    maintenance = app.get(InspectionMaintenanceService);
    storage = app.get(ObjectStorageService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
    await asApp?.$disconnect();
  });

  // ----------------------------------------------------------------
  // 1. Cross-tenant via bogus tenant GUC blocked by RLS
  // ----------------------------------------------------------------

  it('RLS blocks reading another tenant\'s inspection_photos under a bogus panorama.current_tenant', async () => {
    // Seed: upload a photo in tenant A via the HTTP path so the row
    // truly lives there.
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, assetA);
    const photo = await uploadPhoto(url, cookie, inspection.id, plainJpeg);

    // Now pretend to be a buggy / hostile caller running as the app
    // role with tenantB's id in the GUC. RLS should fold the rows.
    const visible = await asApp.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantB}'`);
      return tx.inspectionPhoto.findMany({ where: { id: photo.id } });
    });
    expect(visible).toEqual([]);

    // And under tenantA the row is visible (sanity that the test
    // setup itself isn't broken some other way).
    const visibleA = await asApp.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantA}'`);
      return tx.inspectionPhoto.findMany({ where: { id: photo.id } });
    });
    expect(visibleA.length).toBe(1);
  });

  // ----------------------------------------------------------------
  // 2. DB CHECK on storageKey
  // ----------------------------------------------------------------

  it('DB CHECK rejects an inspection_photo with a malformed storageKey (UUID-strict regex)', async () => {
    // Use the super-admin role so RLS doesn't gate; the failure we
    // want to exercise is the row-level CHECK constraint.
    const inspection = await admin.inspection.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    const driverUser = await admin.user.findFirstOrThrow({
      where: { email: driverEmail },
    });
    const id = randomUUID();
    const malformed = `tenants/${tenantA}/../../etc/passwd`;
    await expect(
      admin.inspectionPhoto.create({
        data: {
          id,
          tenantId: tenantA,
          inspectionId: inspection.id,
          clientUploadKey: randomUUID(),
          storageKey: malformed,
          contentType: 'image/jpeg',
          sizeBytes: 100,
          sha256: 'a'.repeat(64),
          width: 1,
          height: 1,
          uploadedByUserId: driverUser.id,
        },
      }),
    ).rejects.toThrow(/check constraint|inspection_photos_storage_key_shape/i);
  });

  // ----------------------------------------------------------------
  // 3. Template precedence (categoryId > categoryKind)
  // ----------------------------------------------------------------

  it('start() snapshots the categoryId-scoped template, not the categoryKind one', async () => {
    const cookie = await login(url, driverEmail, password);
    const start = await fetch(`${url}/inspections`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: assetA }),
    });
    expect(start.status).toBe(201);
    const created = (await start.json()) as { id: string; templateId: string | null };
    expect(created.templateId).toBe(templateAById);

    const fetched = (await (
      await fetch(`${url}/inspections/${created.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { name: string; items: Array<{ label: string }> } };
    expect(fetched.templateSnapshot.name).toBe('Trucks-specific template');
    expect(fetched.templateSnapshot.items[0]?.label).toBe('Trucks-specific check');

    // Cleanup so the resume window doesn't trip downstream tests.
    await fetch(`${url}/inspections/${created.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  // ----------------------------------------------------------------
  // 4. photo.viewed audit dedup-per-minute
  // ----------------------------------------------------------------

  it('photo.viewed dedups per-minute on detail view; switching to list view emits a fresh audit', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, assetA);
    const photo = await uploadPhoto(url, cookie, inspection.id, plainJpeg);

    const baseline = await admin.auditEvent.count({
      where: {
        action: 'panorama.inspection.photo.viewed',
        resourceId: photo.id,
      },
    });

    // First detail view → +1 audit
    let res = await fetch(`${url}/inspections/${inspection.id}/photos/${photo.id}`, {
      method: 'GET',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    // Allow audit to land — `audit.record` is fire-and-tx; should be
    // immediate, but a tiny yield avoids races on slow CI.
    await new Promise((r) => setTimeout(r, 50));

    const afterFirst = await admin.auditEvent.count({
      where: { action: 'panorama.inspection.photo.viewed', resourceId: photo.id },
    });
    expect(afterFirst).toBe(baseline + 1);

    // Second detail view within window → still baseline+1 (deduped).
    res = await fetch(`${url}/inspections/${inspection.id}/photos/${photo.id}`, {
      method: 'GET',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 50));
    const afterSecond = await admin.auditEvent.count({
      where: { action: 'panorama.inspection.photo.viewed', resourceId: photo.id },
    });
    expect(afterSecond).toBe(baseline + 1);

    // Switch to list view (different dedup key) → +1.
    res = await fetch(`${url}/inspections/${inspection.id}/photos/${photo.id}?view=list`, {
      method: 'GET',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 50));
    const afterList = await admin.auditEvent.count({
      where: { action: 'panorama.inspection.photo.viewed', resourceId: photo.id },
    });
    expect(afterList).toBe(baseline + 2);
  });

  // ----------------------------------------------------------------
  // 5. Retention sweep removes the S3 object (not just the DB row)
  // ----------------------------------------------------------------

  it('retention sweep also deletes the S3 object', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, assetA);
    const photo = await uploadPhoto(url, cookie, inspection.id, plainJpeg);

    const row = await admin.inspectionPhoto.findUniqueOrThrow({
      where: { id: photo.id },
    });

    // MinIO returns 403 for both "missing key" and "no auth" on
    // anonymous HEAD — same status, no signal. Use the
    // ObjectStorageService's signed URL (signature carries the
    // creds) so a missing object surfaces as a clean 404.
    const signedBefore = await storage.getSignedUrl(row.storageKey, {
      tenantId: tenantA,
    });
    const headBefore = await fetch(signedBefore, { method: 'GET' });
    expect(headBefore.status).toBe(200);

    // Soft-delete + back-date past 425 d default.
    await admin.inspectionPhoto.update({
      where: { id: photo.id },
      data: { deletedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000) },
    });

    await maintenance.runPhotoRetentionSweep();

    // Re-mint a signed URL on the same key (the row is gone but
    // assertKeyForTenant only inspects the key shape + prefix; both
    // still match). MinIO answers 404 because the object isn't there.
    const signedAfter = await storage.getSignedUrl(row.storageKey, {
      tenantId: tenantA,
    });
    const headAfter = await fetch(signedAfter, { method: 'GET' });
    expect(headAfter.status).toBe(404);
  });
});

async function startInspection(
  baseUrl: string,
  cookie: string,
  assetId: string,
): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/inspections`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ assetId }),
  });
  if (res.status !== 201) {
    throw new Error(`start failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

async function uploadPhoto(
  baseUrl: string,
  cookie: string,
  inspectionId: string,
  buffer: Buffer,
): Promise<{ id: string; sha256: string }> {
  const form = new FormData();
  form.append('clientUploadKey', randomUUID());
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'p.jpg');
  const res = await fetch(`${baseUrl}/inspections/${inspectionId}/photos`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  if (res.status !== 201) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; sha256: string };
}

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
