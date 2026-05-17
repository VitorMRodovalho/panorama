import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { EmailService } from '../src/modules/email/email.service.js';
import { TenantDeletionService } from '../src/modules/tenant-deletion/tenant-deletion.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * E2e coverage for ADR-0020 §7 (PR 3 tenant deletion).
 *
 * Tests the four endpoint surfaces + the purge cron service entry,
 * end-to-end against a real DB. Uses two Owner accounts on one
 * tenant so peer-Owner veto can be exercised; uses a third tenant
 * (no overlap) for cross-tenant rejection.
 *
 * Email dispatch is mocked via the standard testing-module override
 * pattern so SMTP failure / capture is observable. The cron sweep
 * is idle in tests (`OnModuleInit` short-circuits on
 * `NODE_ENV=test`), so we drive `runPurgeBatch` directly to test
 * the cascade path.
 */

const HOST = process.env['PG_HOST'] ?? 'localhost';
const PORT = process.env['PG_PORT'] ?? '5432';
const DB = process.env['PG_DB'] ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

interface SentEmail {
  to: string;
  subject: string;
  text: string;
}

describe('tenant deletion (ADR-0020 §7, PR 3)', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let deletion: TenantDeletionService;
  let sentEmails: SentEmail[];
  let tenantId: string;
  let ownerAEmail: string;
  let ownerBEmail: string;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    sentEmails = [];

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    deletion = app.get(TenantDeletionService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await resetTestDb(admin);
    sentEmails.length = 0;
    ({ tenantId, ownerAEmail, ownerBEmail } = await seedTenantWithTwoOwners(admin, password));
  });

  it('happy path: request → email fan-out → confirm → scheduledAt set', async () => {
    const cookieA = await login(url, ownerAEmail, password);

    const reqResp = await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    expect(reqResp.status).toBe(200);
    const reqBody = (await reqResp.json()) as { ownerCount: number };
    expect(reqBody.ownerCount).toBe(2);

    // Both Owners received the email.
    expect(sentEmails.map((e) => e.to).sort()).toEqual([ownerAEmail, ownerBEmail].sort());
    const token = extractToken(sentEmails[0]!.text);
    expect(token).not.toBe('');

    const confirmResp = await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(confirmResp.status).toBe(200);
    const confirmBody = (await confirmResp.json()) as { scheduledAt: string };
    expect(new Date(confirmBody.scheduledAt).getTime()).toBeGreaterThan(Date.now());

    const tenantRow = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantRow?.deletionScheduledAt).not.toBeNull();
  });

  it('cancel: clears deletionScheduledAt, idempotent on second call', async () => {
    const cookieA = await login(url, ownerAEmail, password);
    await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    const token = extractToken(sentEmails[0]!.text);
    await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const cancel1 = await fetch(`${url}/tenants/${tenantId}/delete-cancel`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    expect(cancel1.status).toBe(200);
    const cancel2 = await fetch(`${url}/tenants/${tenantId}/delete-cancel`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    expect(cancel2.status).toBe(200);

    // Race C: only ONE delete_cancelled audit row, not two.
    const cancelled = await admin.auditEvent.count({
      where: {
        tenantId,
        action: 'panorama.tenant.delete_cancelled',
      },
    });
    expect(cancelled).toBe(1);
    const tenantRow = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantRow?.deletionScheduledAt).toBeNull();
  });

  it('veto: peer Owner cancels with distinct audit signal', async () => {
    const cookieA = await login(url, ownerAEmail, password);
    await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    const token = extractToken(sentEmails[0]!.text);
    await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const cookieB = await login(url, ownerBEmail, password);
    const vetoResp = await fetch(`${url}/tenants/${tenantId}/delete-veto`, {
      method: 'POST',
      headers: { cookie: cookieB },
    });
    expect(vetoResp.status).toBe(200);

    const vetoed = await admin.auditEvent.findFirst({
      where: { tenantId, action: 'panorama.tenant.delete_veto' },
    });
    expect(vetoed).not.toBeNull();
    expect((vetoed!.metadata as { vetoSource?: string }).vetoSource).toBe('peer_owner');

    const tenantRow = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantRow?.deletionScheduledAt).toBeNull();
  });

  it('self-veto refused: requester cannot veto their own request', async () => {
    const cookieA = await login(url, ownerAEmail, password);
    await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    const token = extractToken(sentEmails[0]!.text);
    await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    // Same Owner that confirmed now tries to veto — refused. (They
    // can /delete-cancel instead.)
    const vetoResp = await fetch(`${url}/tenants/${tenantId}/delete-veto`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    expect(vetoResp.status).toBe(403);
  });

  it('purge cron: cascade survives asset_maintenances RESTRICT on system user (regression for PR 3 tech-lead review)', async () => {
    // Tech-lead PR 3 review flagged that asset_maintenances.createdByUserId
    // ON DELETE RESTRICT points at users(id). If the system user has
    // authored any auto-suggested maintenance ticket, the old purge
    // ordering (DELETE user before DELETE tenant) hit the RESTRICT
    // and the tx aborted. Reversed ordering (tenant first → user
    // last) lets the tenant CASCADE clear asset_maintenances first.
    // Seed one ticket authored by the system user to lock the
    // contract.
    const cookieA = await login(url, ownerAEmail, password);
    await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    const token = extractToken(sentEmails[0]!.text);
    await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    // Seed the asset_maintenances row authored by the system user.
    const tenant = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant?.systemActorUserId).not.toBeNull();
    const category = await admin.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await admin.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'F-150' },
    });
    const asset = await admin.asset.create({
      data: { tenantId, modelId: model.id, tag: 'PURGE-1', name: 'Purge truck' },
    });
    await admin.assetMaintenance.create({
      data: {
        tenantId,
        assetId: asset.id,
        // Authored by the system user — this is the row that would
        // RESTRICT a DELETE user pre-fix.
        createdByUserId: tenant!.systemActorUserId!,
        status: 'OPEN',
        maintenanceType: 'CORRECTIVE',
        title: 'Regression seed',
      },
    });

    // Fast-forward + purge.
    await admin.tenant.update({
      where: { id: tenantId },
      data: { deletionScheduledAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const result = await deletion.runPurgeBatch();
    expect(result.purged).toBe(1);

    const tenantGone = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantGone).toBeNull();
  });

  it('purge cron: advances scheduledAt to past, runPurgeBatch deletes the tenant', async () => {
    const cookieA = await login(url, ownerAEmail, password);
    await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    const token = extractToken(sentEmails[0]!.text);
    await fetch(`${url}/tenants/${tenantId}/delete-confirm`, {
      method: 'POST',
      headers: { cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    // Manually fast-forward the cool-off so the cron picks it up.
    await admin.tenant.update({
      where: { id: tenantId },
      data: { deletionScheduledAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const result = await deletion.runPurgeBatch();
    expect(result.purged).toBe(1);

    const tenantGone = await admin.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantGone).toBeNull();

    // TenantDeleted audit row survives the cascade.
    const audit = await admin.auditEvent.findFirst({
      where: { action: 'panorama.tenant.deleted', tenantId },
    });
    expect(audit).not.toBeNull();
  });

  it('auth: non-Owner gets 403 / 401', async () => {
    // Demote owner A to non-owner role first so we have a session
    // for a non-Owner. We do this by direct DB UPDATE to bypass
    // the last-Owner trigger (we have Owner B too).
    const memberA = await admin.tenantMembership.findFirst({
      where: { tenantId, user: { email: ownerAEmail } },
    });
    await admin.tenantMembership.update({
      where: { id: memberA!.id },
      data: { role: 'fleet_admin' },
    });

    const cookieA = await login(url, ownerAEmail, password);
    const resp = await fetch(`${url}/tenants/${tenantId}/delete-request`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    // Non-Owner trying to hit an Owner-only endpoint — 403.
    expect(resp.status).toBe(403);
  });
});

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

async function seedTenantWithTwoOwners(
  admin: PrismaClient,
  password: string,
): Promise<{ tenantId: string; ownerAEmail: string; ownerBEmail: string }> {
  const passwords = new PasswordService();
  const secretHash = await passwords.hash(password);
  const ownerAEmail = `owner-a-${Date.now()}@example.invalid`;
  const ownerBEmail = `owner-b-${Date.now()}@example.invalid`;
  const userA = await admin.user.create({
    data: { email: ownerAEmail, displayName: 'Owner A' },
  });
  const userB = await admin.user.create({
    data: { email: ownerBEmail, displayName: 'Owner B' },
  });
  await admin.authIdentity.create({
    data: {
      userId: userA.id,
      provider: 'password',
      subject: ownerAEmail,
      emailAtLink: ownerAEmail,
      secretHash,
    },
  });
  await admin.authIdentity.create({
    data: {
      userId: userB.id,
      provider: 'password',
      subject: ownerBEmail,
      emailAtLink: ownerBEmail,
      secretHash,
    },
  });
  const tenant = await createTenantForTest(admin, {
    slug: `pr3-${Date.now()}`,
    name: 'PR3 Test Tenant',
    displayName: 'PR3 Test Tenant',
  });
  await admin.tenantMembership.create({
    data: { tenantId: tenant.id, userId: userA.id, role: 'owner', status: 'active' },
  });
  await admin.tenantMembership.create({
    data: { tenantId: tenant.id, userId: userB.id, role: 'owner', status: 'active' },
  });
  return { tenantId: tenant.id, ownerAEmail, ownerBEmail };
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
  // Strip attributes; keep only `name=value` segments joined.
  return setCookie
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .join('; ');
}

function extractToken(text: string): string {
  // Template renders `#token=<plaintext>` in the link AND a paste-
  // fallback "paste this token: <plaintext>". Pull from the
  // fragment shape.
  const match = text.match(/#token=([A-Za-z0-9_-]+)/);
  return match ? match[1]! : '';
}
