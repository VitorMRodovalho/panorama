import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { InspectionMaintenanceService } from '../src/modules/inspection/inspection-maintenance.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * InspectionMaintenanceService e2e (ADR-0012 §9 + §10).
 *
 * Drives the sweeps directly via the service instead of waiting on
 * setInterval. Production cadence = daily for retention, hourly for
 * stale; here we tickOnce after back-dating fixtures.
 *
 * Hard requires: MinIO + Postgres + Redis (other suites already need
 * them).
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('inspection maintenance e2e', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let maintenance: InspectionMaintenanceService;

  let tenantId: string;
  let assetId: string;
  let driverEmail: string;
  let driverId: string;
  let ownerEmail: string;
  let ownerId: string;
  const password = 'correct-horse-battery-staple';

  let plainJpeg: Buffer;

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    const minioCheck = await fetch('http://localhost:9000/minio/health/live').catch(() => null);
    if (!minioCheck || minioCheck.status !== 200) {
      throw new Error(
        'MinIO not reachable at http://localhost:9000 — start the dev stack: docker-compose -f infra/docker/compose.dev.yml up -d minio',
      );
    }

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const t = await admin.tenant.create({
      data: { slug: 'maint-test', name: 'Maint Test', displayName: 'Maint Test' },
    });
    tenantId = t.id;
    const cat = await admin.category.create({
      data: { tenantId, name: 'Trucks', kind: 'VEHICLE' },
    });
    const model = await admin.assetModel.create({
      data: { tenantId, categoryId: cat.id, name: 'F-150' },
    });
    const asset = await admin.asset.create({
      data: { tenantId, modelId: model.id, tag: 'M-1', name: 'Maint truck' },
    });
    assetId = asset.id;

    ownerEmail = 'owner.maint@example.com';
    driverEmail = 'driver.maint@example.com';
    const ownerUser = await admin.user.create({
      data: { email: ownerEmail, displayName: 'Olivia Owner' },
    });
    ownerId = ownerUser.id;
    const driverUser = await admin.user.create({
      data: { email: driverEmail, displayName: 'Drew Driver' },
    });
    driverId = driverUser.id;
    await admin.tenantMembership.createMany({
      data: [
        { tenantId, userId: ownerUser.id, role: 'owner' },
        { tenantId, userId: driverUser.id, role: 'driver' },
      ],
    });

    const template = await admin.inspectionTemplate.create({
      data: {
        tenantId,
        name: 'Pre-trip',
        categoryKind: 'VEHICLE',
        createdByUserId: ownerUser.id,
      },
    });
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId,
        templateId: template.id,
        position: 0,
        label: 'Lights',
        itemType: 'BOOLEAN',
      },
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        { userId: ownerUser.id, provider: 'password', subject: ownerEmail, emailAtLink: ownerEmail, secretHash },
        { userId: driverUser.id, provider: 'password', subject: driverEmail, emailAtLink: driverEmail, secretHash },
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  // ----------------------------------------------------------------
  // Photo retention sweep
  // ----------------------------------------------------------------

  it('retention sweep hard-deletes soft-deleted photos past the cutoff', async () => {
    // Upload a photo via service path so the storageKey + S3 object
    // both exist.
    const driverCookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, driverCookie, assetId);
    const upload = await uploadPhoto(url, driverCookie, inspection.id, plainJpeg);

    // Soft-delete + back-date past 425 d default.
    await admin.inspectionPhoto.update({
      where: { id: upload.id },
      data: { deletedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000) },
    });

    const before = await admin.inspectionPhoto.findUnique({ where: { id: upload.id } });
    expect(before).toBeTruthy();

    const swept = await maintenance.runPhotoRetentionSweep();
    expect(swept).toBeGreaterThanOrEqual(1);

    const after = await admin.inspectionPhoto.findUnique({ where: { id: upload.id } });
    expect(after).toBeNull();

    const audit = await admin.auditEvent.findFirst({
      where: {
        action: 'panorama.inspection.photo.hard_deleted',
        resourceId: upload.id,
      },
    });
    expect(audit).toBeTruthy();
    const md = (audit!.metadata as Record<string, unknown> | null) ?? {};
    expect(md['reason']).toBe('retention_sweep');
  });

  it('per-tenant override respected (DB CHECK enforces 30-day floor)', async () => {
    // The `tenants_inspection_retention_floor` CHECK constraint
    // (migration 0012) refuses anything < 30 — service-layer
    // GREATEST(30, ...) is double-belt, never reached if the column
    // change is rejected first.
    await expect(
      admin.tenant.update({
        where: { id: tenantId },
        data: { inspectionPhotoRetentionDays: 7 },
      }),
    ).rejects.toThrow(/tenants_inspection_retention_floor/);

    // Now use the minimum allowed value (30 d) and verify a 25-day-
    // soft-deleted row stays while a 40-day one is swept.
    await admin.tenant.update({
      where: { id: tenantId },
      data: { inspectionPhotoRetentionDays: 30 },
    });

    const driverCookie = await login(url, driverEmail, password);
    const inspection = await startInspection(url, driverCookie, assetId);
    const fresh = await uploadPhoto(url, driverCookie, inspection.id, plainJpeg);
    const aged = await uploadPhoto(url, driverCookie, inspection.id, plainJpeg);

    await admin.inspectionPhoto.update({
      where: { id: fresh.id },
      data: { deletedAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000) },
    });
    await admin.inspectionPhoto.update({
      where: { id: aged.id },
      data: { deletedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    await maintenance.runPhotoRetentionSweep();

    const freshRow = await admin.inspectionPhoto.findUnique({ where: { id: fresh.id } });
    const agedRow = await admin.inspectionPhoto.findUnique({ where: { id: aged.id } });
    expect(freshRow).toBeTruthy();
    expect(agedRow).toBeNull();

    // Reset back to default for downstream tests.
    await admin.tenant.update({
      where: { id: tenantId },
      data: { inspectionPhotoRetentionDays: null },
    });
  });

  it('sweep is a no-op when nothing qualifies', async () => {
    const swept = await maintenance.runPhotoRetentionSweep();
    expect(swept).toBe(0);
  });

  // ----------------------------------------------------------------
  // Stale-in-progress sweep
  // ----------------------------------------------------------------

  it('stale sweep cancels IN_PROGRESS inspections older than 3× staleInProgressHours', async () => {
    // Create an IN_PROGRESS inspection directly (skip HTTP because we
    // need an old startedAt that pre-dates the resume window).
    const template = await admin.inspectionTemplate.findFirstOrThrow({
      where: { tenantId },
    });
    const items = await admin.inspectionTemplateItem.findMany({
      where: { templateId: template.id },
      orderBy: { position: 'asc' },
    });
    const stale = await admin.inspection.create({
      data: {
        tenantId,
        templateId: template.id,
        templateSnapshot: {
          name: template.name,
          description: template.description,
          templateVersionAt: new Date().toISOString(),
          items: items.map((it) => ({
            id: it.id,
            position: it.position,
            label: it.label,
            itemType: it.itemType,
            required: it.required,
            photoRequired: it.photoRequired,
            minValue: it.minValue,
            maxValue: it.maxValue,
            helpText: it.helpText,
          })),
        } as never,
        assetId,
        startedByUserId: driverId,
        startedAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
      },
    });
    const fresh = await admin.inspection.create({
      data: {
        tenantId,
        templateId: template.id,
        templateSnapshot: {
          name: template.name,
          description: template.description,
          templateVersionAt: new Date().toISOString(),
          items: items.map((it) => ({
            id: it.id,
            position: it.position,
            label: it.label,
            itemType: it.itemType,
            required: it.required,
            photoRequired: it.photoRequired,
            minValue: it.minValue,
            maxValue: it.maxValue,
            helpText: it.helpText,
          })),
        } as never,
        assetId,
        startedByUserId: ownerId,
        startedAt: new Date(),
      },
    });

    const cancelled = await maintenance.runStaleInProgressSweep();
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const staleAfter = await admin.inspection.findUnique({ where: { id: stale.id } });
    const freshAfter = await admin.inspection.findUnique({ where: { id: fresh.id } });
    expect(staleAfter?.status).toBe('CANCELLED');
    expect(freshAfter?.status).toBe('IN_PROGRESS');

    const audit = await admin.auditEvent.findFirst({
      where: {
        action: 'panorama.inspection.auto_cancelled',
        resourceId: stale.id,
      },
    });
    expect(audit).toBeTruthy();
    const md = (audit!.metadata as Record<string, unknown> | null) ?? {};
    expect(md['reason']).toBe('auto_cancel_stale');
    expect(typeof md['hoursStale']).toBe('number');

    // Cleanup the fresh row so it doesn't bleed.
    await admin.inspection.update({
      where: { id: fresh.id },
      data: { status: 'CANCELLED' },
    });
  });

  it('stale sweep no-ops when nothing qualifies', async () => {
    const cancelled = await maintenance.runStaleInProgressSweep();
    expect(cancelled).toBe(0);
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

// `createHash` import retained as a sanity for any test that wants to
// re-verify uploaded bytes — currently unused in this file but
// expected to land in the GDPR hard-delete e2e (step 10).
void createHash;
