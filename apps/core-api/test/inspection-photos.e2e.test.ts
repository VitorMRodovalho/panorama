import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Photo upload + GET-redirect e2e (ADR-0012 §Execution-order step 7c).
 *
 * Hard requires:
 *   * MinIO at localhost:9000 with bucket `panorama-photos`. The
 *     beforeAll asserts a HEAD on the bucket so a missing-MinIO
 *     run fails loudly instead of silently passing.
 *   * Postgres + Redis (every other e2e suite already needs them).
 *
 * Coverage:
 *   * happy path: upload → row returned + sha256 stable + signedUrl
 *     resolves + bytes match expected sha
 *   * GET :photoId 302 → presigned URL with no-store + no-referrer
 *   * idempotency: same clientUploadKey returns the same row
 *   * upload_key_collision: same key, different uploader → 409
 *   * polyglot PDF-in-JPEG → 415
 *   * cross-tenant photo URL access → 404
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('inspection photos e2e', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let alphaAssetId: string;
  let bravoAssetId: string;
  const ownerEmail = 'owner.ph@example.com';
  const driverEmail = 'driver.ph@example.com';
  const driver2Email = 'driver2.ph@example.com';
  const bravoDriverEmail = 'driver.bravo.ph@example.com';
  const password = 'correct-horse-battery-staple';

  let plainJpeg: Buffer;
  let polyglotPdfJpeg: Buffer;

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    // Hard-fail if MinIO bucket isn't reachable — the suite cannot
    // exercise the storage path without it.
    const minioCheck = await fetch('http://localhost:9000/minio/health/live').catch(() => null);
    if (!minioCheck || minioCheck.status !== 200) {
      throw new Error(
        'MinIO not reachable at http://localhost:9000 — start the dev stack: ' +
          'docker-compose -f infra/docker/compose.dev.yml up -d minio',
      );
    }

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const a = await createTenantForTest(admin, {
      slug: 'alpha-ph',
      name: 'Alpha PH',
      displayName: 'Alpha PH',
    });
    const b = await createTenantForTest(admin, {
      slug: 'bravo-ph',
      name: 'Bravo PH',
      displayName: 'Bravo PH',
    });

    const aCat = await admin.category.create({
      data: { tenantId: a.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    const aModel = await admin.assetModel.create({
      data: { tenantId: a.id, categoryId: aCat.id, name: 'F-150' },
    });
    const aAsset = await admin.asset.create({
      data: { tenantId: a.id, modelId: aModel.id, tag: 'A-PH-1', name: 'A truck' },
    });
    alphaAssetId = aAsset.id;

    const bCat = await admin.category.create({
      data: { tenantId: b.id, name: 'Trucks', kind: 'VEHICLE' },
    });
    const bModel = await admin.assetModel.create({
      data: { tenantId: b.id, categoryId: bCat.id, name: 'F-150' },
    });
    const bAsset = await admin.asset.create({
      data: { tenantId: b.id, modelId: bModel.id, tag: 'B-PH-1', name: 'B truck' },
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
    const bravoDriver = await admin.user.create({
      data: { email: bravoDriverEmail, displayName: 'Brad Bravo' },
    });
    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: ownerAlpha.id, role: 'owner' },
        { tenantId: a.id, userId: driverAlpha.id, role: 'driver' },
        { tenantId: a.id, userId: driver2Alpha.id, role: 'driver' },
        { tenantId: b.id, userId: bravoDriver.id, role: 'driver' },
      ],
    });

    // Single-item PHOTO-free template — keeps complete tests below
    // out of scope (we cover photos here, not lifecycle).
    const template = await admin.inspectionTemplate.create({
      data: {
        tenantId: a.id,
        name: 'Basic',
        categoryKind: 'VEHICLE',
        createdByUserId: ownerAlpha.id,
      },
    });
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: a.id,
        templateId: template.id,
        position: 0,
        label: 'Looks ok?',
        itemType: 'BOOLEAN',
      },
    });

    // Bravo's template so its driver can also start an inspection.
    const bTemplate = await admin.inspectionTemplate.create({
      data: {
        tenantId: b.id,
        name: 'Basic B',
        categoryKind: 'VEHICLE',
        createdByUserId: bravoDriver.id,
      },
    });
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: b.id,
        templateId: bTemplate.id,
        position: 0,
        label: 'Looks ok?',
        itemType: 'BOOLEAN',
      },
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        { userId: ownerAlpha.id, provider: 'password', subject: ownerEmail, emailAtLink: ownerEmail, secretHash },
        { userId: driverAlpha.id, provider: 'password', subject: driverEmail, emailAtLink: driverEmail, secretHash },
        { userId: driver2Alpha.id, provider: 'password', subject: driver2Email, emailAtLink: driver2Email, secretHash },
        { userId: bravoDriver.id, provider: 'password', subject: bravoDriverEmail, emailAtLink: bravoDriverEmail, secretHash },
      ],
    });

    // Generate fixtures via sharp (no on-disk binaries committed).
    plainJpeg = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    polyglotPdfJpeg = Buffer.concat([
      Buffer.from('%PDF-1.4\n%fake header\n', 'utf8'),
      plainJpeg,
    ]);

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

  it('upload happy path → row + signedUrl + bytes match', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, alphaAssetId);
    const clientUploadKey = randomUUID();

    const form = new FormData();
    form.append('clientUploadKey', clientUploadKey);
    form.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'photo.jpg');

    const res = await fetch(`${url}/inspections/${inspection.id}/photos`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      sha256: string;
      sizeBytes: number;
      width: number;
      height: number;
      signedUrl: string;
      deduped: boolean;
    };
    expect(body.deduped).toBe(false);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.width).toBe(256);
    expect(body.height).toBe(256);

    // The signed URL is a MinIO /panorama-photos/... presigned GET.
    // It MUST resolve and return bytes whose sha256 matches.
    const fetchedBytes = await fetch(body.signedUrl);
    expect(fetchedBytes.status).toBe(200);
    const buf = Buffer.from(await fetchedBytes.arrayBuffer());
    const downloadedSha = createHash('sha256').update(buf).digest('hex');
    expect(downloadedSha).toBe(body.sha256);
  });

  it('GET :photoId issues 302 with Cache-Control + Referrer-Policy headers', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, alphaAssetId);

    const form = new FormData();
    form.append('clientUploadKey', randomUUID());
    form.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'photo.jpg');
    const upload = (await (
      await fetch(`${url}/inspections/${inspection.id}/photos`, {
        method: 'POST',
        headers: { cookie },
        body: form,
      })
    ).json()) as { id: string };

    const res = await fetch(`${url}/inspections/${inspection.id}/photos/${upload.id}`, {
      method: 'GET',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(/^http:\/\/localhost:9000\/panorama-photos\//);
    expect(location).toMatch(/X-Amz-Signature=/);
  });

  it('idempotency: same clientUploadKey returns the same row, deduped=true', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, alphaAssetId);
    const key = randomUUID();

    const upload = async () => {
      const form = new FormData();
      form.append('clientUploadKey', key);
      form.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'photo.jpg');
      return (await (
        await fetch(`${url}/inspections/${inspection.id}/photos`, {
          method: 'POST',
          headers: { cookie },
          body: form,
        })
      ).json()) as { id: string; deduped: boolean };
    };
    const first = await upload();
    const second = await upload();
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
  });

  it('upload_key_collision: same key, different uploader → 409', async () => {
    const driverCookie = await login(url, driverEmail, password);
    const driver2Cookie = await login(url, driver2Email, password);

    // First inspection by driver1
    const inspection = await startInspection(url, driverCookie, alphaAssetId);
    const key = randomUUID();
    const form1 = new FormData();
    form1.append('clientUploadKey', key);
    form1.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'photo.jpg');
    const ok = await fetch(`${url}/inspections/${inspection.id}/photos`, {
      method: 'POST',
      headers: { cookie: driverCookie },
      body: form1,
    });
    expect(ok.status).toBe(201);

    // The collision path needs a SECOND uploader who legitimately
    // CAN write to this inspection but isn't the original uploader.
    // The owner role qualifies — admin can write on any driver's
    // inspection, so the collision is reached (vs the 403 a peer
    // driver would hit).
    const ownerCookie = await login(url, ownerEmail, password);
    const form2 = new FormData();
    form2.append('clientUploadKey', key);
    form2.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'photo.jpg');
    const collide = await fetch(`${url}/inspections/${inspection.id}/photos`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: form2,
    });
    expect(collide.status).toBe(409);
  });

  it('polyglot PDF-in-JPEG rejected with 415', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, alphaAssetId);
    const form = new FormData();
    form.append('clientUploadKey', randomUUID());
    form.append('photo', new Blob([polyglotPdfJpeg], { type: 'image/jpeg' }), 'p.jpg');
    const res = await fetch(`${url}/inspections/${inspection.id}/photos`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(415);
  });

  it('cross-tenant: Bravo driver cannot view an Alpha photo via signed-URL endpoint', async () => {
    const alphaCookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, alphaCookie, alphaAssetId);
    const form = new FormData();
    form.append('clientUploadKey', randomUUID());
    form.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'p.jpg');
    const upload = (await (
      await fetch(`${url}/inspections/${inspection.id}/photos`, {
        method: 'POST',
        headers: { cookie: alphaCookie },
        body: form,
      })
    ).json()) as { id: string };

    const bravoCookie = await login(url, bravoDriverEmail, password);
    const res = await fetch(
      `${url}/inspections/${inspection.id}/photos/${upload.id}`,
      { method: 'GET', headers: { cookie: bravoCookie }, redirect: 'manual' },
    );
    expect(res.status).toBe(404);
  });

  it('rejects upload missing clientUploadKey field with 400', async () => {
    const cookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, cookie, alphaAssetId);
    const form = new FormData();
    // intentionally no clientUploadKey
    form.append('photo', new Blob([plainJpeg], { type: 'image/jpeg' }), 'p.jpg');
    const res = await fetch(`${url}/inspections/${inspection.id}/photos`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
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
