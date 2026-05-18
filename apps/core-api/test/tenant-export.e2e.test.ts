import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { gunzipSync } from 'node:zlib';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { EmailService } from '../src/modules/email/email.service.js';
import { ObjectStorageService } from '../src/modules/object-storage/object-storage.service.js';
import { TenantExportService } from '../src/modules/tenant-export/tenant-export.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * E2e coverage for ADR-0020 §8 (PR 4 tenant data export).
 *
 * Drives the request → enqueue → worker → audit + S3 + email path
 * end-to-end. ObjectStorageService is mocked to capture put +
 * getSignedUrl calls (the SSRF guard at boot would require a real
 * S3 endpoint otherwise). EmailService mock captures the
 * completion email. The BullMQ queue is idle-in-tests; the test
 * invokes `TenantExportService.runJob` directly so the worker path
 * runs inline.
 */

const HOST = process.env['PG_HOST'] ?? 'localhost';
const PORT = process.env['PG_PORT'] ?? '5432';
const DB = process.env['PG_DB'] ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';

interface PutCall {
  key: string;
  body: Buffer;
  tenantId: string;
}

interface SentEmail {
  to: string;
  subject: string;
  text: string;
}

interface SignedUrlCall {
  key: string;
  responseContentType?: string;
  responseContentDisposition?: string;
  expiresIn?: number;
}

describe('tenant export (ADR-0020 §8, PR 4)', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let redis: Redis;
  let exports: TenantExportService;
  let puts: PutCall[];
  let signedUrlCalls: SignedUrlCall[];
  let sentEmails: SentEmail[];
  let tenantId: string;
  let ownerEmail: string;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    redis = new Redis(REDIS_URL);
    await flushExportKeys(redis);

    puts = [];
    signedUrlCalls = [];
    sentEmails = [];

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ObjectStorageService)
      .useValue({
        // Tests don't reach real S3 — capture the call shape so we
        // can assert the key matches the §8 pattern + the gzipped
        // body round-trips through gunzip cleanly.
        put: async (
          key: string,
          body: Buffer,
          opts: { tenantId: string },
        ) => {
          puts.push({ key, body, tenantId: opts.tenantId });
        },
        getSignedUrl: async (
          key: string,
          opts: {
            responseContentType?: string;
            responseContentDisposition?: string;
            expiresIn?: number;
          },
        ) => {
          signedUrlCalls.push({
            key,
            ...(opts.responseContentType !== undefined ? { responseContentType: opts.responseContentType } : {}),
            ...(opts.responseContentDisposition !== undefined ? { responseContentDisposition: opts.responseContentDisposition } : {}),
            ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
          });
          return `https://s3.test.invalid/${encodeURIComponent(key)}?X-Amz-Signature=fake`;
        },
        onModuleInit: async () => {},
      })
      .overrideProvider(EmailService)
      .useValue({
        send: async (input: { to: string; subject: string; text: string }) => {
          sentEmails.push({ to: input.to, subject: input.subject, text: input.text });
          return { messageId: `mock-${sentEmails.length}` };
        },
        onModuleDestroy: async () => {},
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
    exports = app.get(TenantExportService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
    await redis?.quit();
  });

  beforeEach(async () => {
    await resetTestDb(admin);
    await flushExportKeys(redis);
    puts.length = 0;
    signedUrlCalls.length = 0;
    sentEmails.length = 0;
    ({ tenantId, ownerEmail } = await seedTenantWithOwner(admin, password));
  });

  it('happy path: POST → enqueues row → worker uploads gzipped JSON + emails signed URL', async () => {
    const cookie = await login(url, ownerEmail, password);
    const resp = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { jobId: string; status: string };
    expect(body.status).toBe('queued');

    // Drive the worker inline (BullMQ idle in tests).
    await exports.runJob(body.jobId);

    // S3 put captured with the §8 key shape + gzipped body that
    // round-trips through gunzip.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(
      /^tenants\/[0-9a-f-]+\/exports\/[0-9a-f-]+\.json\.gz$/,
    );
    const decompressed = gunzipSync(puts[0]!.body).toString('utf8');
    const doc = JSON.parse(decompressed) as {
      panoramaExport: { tenantId: string };
      tables: Record<string, unknown[]>;
    };
    expect(doc.panoramaExport.tenantId).toBe(tenantId);
    // Core MVP tables present in the export.
    for (const expected of [
      'tenants',
      'tenant_memberships',
      'users',
      'assets',
      'reservations',
      'inspections',
      'asset_maintenances',
    ]) {
      expect(doc.tables).toHaveProperty(expected);
    }
    expect(doc.tables.tenants).toHaveLength(1);

    // Completion email body links to the Panorama download endpoint
    // (NOT a presigned S3 URL — security-reviewer PR 4 BLOCKER 3).
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(ownerEmail);
    expect(sentEmails[0]!.text).toContain(
      `/tenants/${tenantId}/exports/${body.jobId}/download`,
    );
    expect(sentEmails[0]!.text).not.toContain('s3.test.invalid');
    expect(sentEmails[0]!.text).not.toContain('X-Amz-Signature');

    // Audit trail: TenantExportRequested + TenantExported.
    const requested = await admin.auditEvent.count({
      where: { tenantId, action: 'panorama.tenant.export_requested' },
    });
    expect(requested).toBe(1);
    const exported = await admin.auditEvent.findFirst({
      where: { tenantId, action: 'panorama.tenant.exported' },
    });
    expect(exported).not.toBeNull();
    // §8 contract: audit row records objectKey, NOT the signed URL.
    const exportedMeta = exported!.metadata as { objectKey?: string };
    expect(exportedMeta.objectKey).toMatch(/^tenants\/[0-9a-f-]+\/exports\//);
    expect(JSON.stringify(exported!.metadata)).not.toContain('X-Amz-Signature');

    // The tenant_exports row is in the completed state.
    const row = await admin.tenantExport.findUnique({ where: { id: body.jobId } });
    expect(row?.status).toBe('completed');
    expect(row?.objectKey).toMatch(/\.json\.gz$/);
  });

  it('download endpoint: session-gated 302 to short-TTL signed URL with gzip content-type', async () => {
    const cookie = await login(url, ownerEmail, password);
    // Complete an export first.
    const enqueue = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    const { jobId } = (await enqueue.json()) as { jobId: string };
    await exports.runJob(jobId);
    const beforeDownload = signedUrlCalls.length;

    // Unauthenticated GET against the download path: 401. The
    // signed URL is NEVER minted on this path — mail-scanner
    // prefetch can't extract the file (security-reviewer PR 4
    // BLOCKER 3 regression).
    const noSessionResp = await fetch(
      `${url}/tenants/${tenantId}/exports/${jobId}/download`,
      { redirect: 'manual' },
    );
    expect(noSessionResp.status).toBe(401);
    expect(signedUrlCalls.length).toBe(beforeDownload);

    // Authenticated GET: 302 to a freshly-minted signed URL with
    // `application/gzip` content-type + tenant-export filename
    // (BLOCKER 1 — was hardcoded to image/jpeg before the fix).
    const sessionResp = await fetch(
      `${url}/tenants/${tenantId}/exports/${jobId}/download`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(sessionResp.status).toBe(302);
    expect(sessionResp.headers.get('location')).toMatch(/^https:\/\/s3\.test\.invalid\//);
    const mintCall = signedUrlCalls[signedUrlCalls.length - 1]!;
    expect(mintCall.responseContentType).toBe('application/gzip');
    expect(mintCall.responseContentDisposition).toBe(
      `attachment; filename="panorama-export-${jobId}.json.gz"`,
    );
    // 60s short-TTL URL (the long-lived window applies to the
    // Panorama route, not the S3 URL).
    expect(mintCall.expiresIn).toBe(60);
  });

  it('serializer omits invitation tokenHash (security-reviewer BLOCKER 2)', async () => {
    // Seed an invitation so the export includes one in the
    // invitations table; the export body must NOT carry tokenHash.
    const inviter = await admin.user.findFirst({
      where: { email: ownerEmail },
    });
    await admin.invitation.create({
      data: {
        tenantId,
        email: 'invitee@example.invalid',
        role: 'driver',
        tokenHash: 'a'.repeat(64),
        invitedByUserId: inviter!.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const cookie = await login(url, ownerEmail, password);
    const resp = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    const { jobId } = (await resp.json()) as { jobId: string };
    await exports.runJob(jobId);
    const body = gunzipSync(puts[0]!.body).toString('utf8');
    expect(body).toContain('invitee@example.invalid');
    expect(body).not.toContain('a'.repeat(64));
    expect(body).not.toMatch(/"tokenHash"/);
  });

  it('rate-limit: second request within 24h returns 429', async () => {
    const cookie = await login(url, ownerEmail, password);
    const first = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(first.status).toBe(202);

    const second = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(second.status).toBe(429);
  });

  it('auth: non-Owner gets 403', async () => {
    // Demote owner to fleet_admin so they have a session but lack
    // the role.
    const membership = await admin.tenantMembership.findFirst({
      where: { tenantId, user: { email: ownerEmail } },
    });
    // Seed a peer Owner first so the demote doesn't trip the
    // last-Owner trigger.
    const peerEmail = `peer-${Date.now()}@example.invalid`;
    const passwords = new PasswordService();
    const peer = await admin.user.create({
      data: { email: peerEmail, displayName: 'Peer Owner' },
    });
    await admin.authIdentity.create({
      data: {
        userId: peer.id,
        provider: 'password',
        subject: peerEmail,
        emailAtLink: peerEmail,
        secretHash: await passwords.hash(password),
      },
    });
    await admin.tenantMembership.create({
      data: { tenantId, userId: peer.id, role: 'owner', status: 'active' },
    });
    await admin.tenantMembership.update({
      where: { id: membership!.id },
      data: { role: 'fleet_admin' },
    });

    const cookie = await login(url, ownerEmail, password);
    const resp = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(resp.status).toBe(403);
  });

  it('issue #228: email-side failure does NOT overwrite completed → failed', async () => {
    // Regression test for the dispatchEmail bug carried across the
    // PR1 / PR2 / PR3 handoffs as risk item #6 (PR1) → persona N1
    // (PR2) → follow-up #4 (PR3). Before the fix, a throw anywhere
    // inside dispatchEmail beyond its own inner try/catch
    // (lookupJobIdByObjectKey, renderExportReadyEmail) propagated
    // to the outer catch in runJob and called markFailed —
    // overwriting a completed row whose export file was already in
    // S3, leaving the tenant with "failed" in the UI but the bytes
    // sitting in the bucket.
    const cookie = await login(url, ownerEmail, password);
    const resp = await fetch(`${url}/tenants/${tenantId}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { jobId: string };

    const dispatchSpy = vi
      .spyOn(
        exports as unknown as { dispatchEmail: (...args: unknown[]) => Promise<void> },
        'dispatchEmail',
      )
      .mockRejectedValueOnce(new Error('synthetic post-completion failure'));

    await exports.runJob(body.jobId);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    const row = await admin.tenantExport.findUnique({ where: { id: body.jobId } });
    // The export file was already uploaded to S3 by markCompleted's
    // moment; the row MUST stay completed so the tenant can download.
    expect(
      row?.status,
      'email failure must not reverse the completed terminal state',
    ).toBe('completed');
    expect(row?.objectKey).toMatch(/\.json\.gz$/);
    // S3 upload happened (markCompleted ran before dispatchEmail).
    expect(puts).toHaveLength(1);

    dispatchSpy.mockRestore();
  });
});

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

async function seedTenantWithOwner(
  admin: PrismaClient,
  password: string,
): Promise<{ tenantId: string; ownerEmail: string }> {
  const passwords = new PasswordService();
  const ownerEmail = `owner-export-${Date.now()}@example.invalid`;
  const user = await admin.user.create({
    data: { email: ownerEmail, displayName: 'Export Owner' },
  });
  await admin.authIdentity.create({
    data: {
      userId: user.id,
      provider: 'password',
      subject: ownerEmail,
      emailAtLink: ownerEmail,
      secretHash: await passwords.hash(password),
    },
  });
  const tenant = await createTenantForTest(admin, {
    slug: `pr4-${Date.now()}`,
    name: 'PR4 Export Test',
    displayName: 'PR4 Export Test',
  });
  await admin.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'owner', status: 'active' },
  });
  return { tenantId: tenant.id, ownerEmail };
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
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login response missing set-cookie');
  return setCookie
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .join('; ');
}

async function flushExportKeys(redis: Redis): Promise<void> {
  const stream = redis.scanStream({ match: 'panorama:export:*', count: 200 });
  for await (const batch of stream) {
    const keys = batch as string[];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
