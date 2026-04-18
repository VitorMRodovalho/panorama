import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Personal Access Token endpoints (ADR-0010 step 4).
 *
 * Covers:
 *   * POST /auth/tokens without session → 401
 *   * POST /auth/tokens with session → 201 + plaintext returned once,
 *     tokenPrefix echoed, tokenHash never exposed
 *   * GET /auth/tokens lists only the caller's tokens; tenant scope
 *     admin-only
 *   * DELETE /auth/tokens/:id by owner → 200 + revokedAt set + audit
 *   * DELETE /auth/tokens/:id by non-owner non-admin → 403
 *   * DELETE /auth/tokens/:id by admin (other user's token) → 200
 *   * Invalid scope → 400
 *   * Invalid name (empty / too long) → 400
 *   * expiresAt in the past → 400
 *   * Rate limit: 11th mint in an hour → 429
 *   * Audit panorama.pat.created + panorama.pat.revoked land
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('personal access token e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;

  const admin = {
    email: 'admin@pat-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'PAT Admin',
  };
  const driver = {
    email: 'driver@pat-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'PAT Driver',
  };
  const otherDriver = {
    email: 'driver2@pat-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'PAT Driver Two',
  };

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie');
    if (!set) throw new Error('no set-cookie');
    return set
      .split(',')
      .map((p) => p.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');
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
      data: { email: admin.email, displayName: admin.displayName },
    });
    const driverUser = await adminDb.user.create({
      data: { email: driver.email, displayName: driver.displayName },
    });
    const otherUser = await adminDb.user.create({
      data: { email: otherDriver.email, displayName: otherDriver.displayName },
    });
    for (const [u, pw] of [
      [adminUser, admin.password],
      [driverUser, driver.password],
      [otherUser, otherDriver.password],
    ] as const) {
      await adminDb.authIdentity.create({
        data: {
          userId: u.id,
          provider: 'password',
          subject: u.email,
          emailAtLink: u.email,
          secretHash: await passwords.hash(pw),
        },
      });
    }

    const tenants = app.get(TenantAdminService);
    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'pat-test',
      name: 'PAT Test',
      displayName: 'PAT Test',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driverUser.id, role: 'driver', status: 'active' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: otherUser.id, role: 'driver', status: 'active' },
    });
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    // Wipe tokens between tests so the rate limit test has room to
    // mint 10 fresh. The limiter key is `pat:issue:<userId>:hour` in
    // Redis — survives the DB wipe, so rate-limit test runs in a
    // dedicated user's scope to avoid contaminating the others.
    await adminDb.personalAccessToken.deleteMany();
  });

  // ---- mint ---------------------------------------------------------

  it('POST /auth/tokens without session → 401', async () => {
    const res = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', scopes: ['snipeit.compat.read'] }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/tokens mints + returns plaintext once, prefix echoed, hash hidden', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'fleet-cluster-prod',
        scopes: ['snipeit.compat.read'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      plaintext: string;
      token: { id: string; tokenPrefix: string; scopes: string[]; name: string };
    } & Record<string, unknown>;

    expect(body.plaintext).toMatch(/^pnrm_pat_[A-Za-z0-9_-]+$/);
    // Prefix is deterministic: "pnrm_pat_" + first 8 chars of the
    // base64url secret part (i.e. of the plaintext minus the literal
    // prefix).
    const secret = body.plaintext.slice('pnrm_pat_'.length);
    expect(body.token.tokenPrefix).toBe(`pnrm_pat_${secret.slice(0, 8)}`);
    expect(body.token.name).toBe('fleet-cluster-prod');
    expect(body.token.scopes).toEqual(['snipeit.compat.read']);
    // Hash MUST NOT appear in the response.
    expect(JSON.stringify(body)).not.toContain('tokenHash');

    // DB ground truth: hash stored, plaintext not.
    const row = await adminDb.personalAccessToken.findUnique({
      where: { id: body.token.id },
    });
    expect(row?.tokenHash).toBeTruthy();
    expect(row?.tokenHash).not.toBe(body.plaintext);

    // Audit row landed.
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.pat.created', resourceId: body.token.id },
    });
    expect(audit).toBeTruthy();
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['tokenId']).toBe(body.token.id);
    expect(meta['tokenPrefix']).toBe(body.token.tokenPrefix);
  });

  it('POST /auth/tokens rejects invalid scope', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-scope',
        scopes: ['admin.everything'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/tokens rejects past expiresAt', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'stale-expiry',
        scopes: ['snipeit.compat.read'],
        expiresAt: past,
      }),
    });
    expect(res.status).toBe(400);
  });

  // ---- list ---------------------------------------------------------

  it('GET /auth/tokens returns only the caller own tokens', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'driver-token', scopes: ['snipeit.compat.read'] }),
    });
    const otherCookie = await loginCookie(otherDriver.email, otherDriver.password);
    await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other-token', scopes: ['snipeit.compat.read'] }),
    });

    const res = await fetch(`${url}/auth/tokens?scope=mine`, {
      headers: { cookie: driverCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.name).toBe('driver-token');
  });

  it('GET /auth/tokens?scope=tenant by driver → 403', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/auth/tokens?scope=tenant`, {
      headers: { cookie: driverCookie },
    });
    expect(res.status).toBe(403);
  });

  it('GET /auth/tokens?scope=tenant by admin → lists every tenant token', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const adminCookie = await loginCookie(admin.email, admin.password);
    await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'd', scopes: ['snipeit.compat.read'] }),
    });
    await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', scopes: ['snipeit.compat.read'] }),
    });
    const res = await fetch(`${url}/auth/tokens?scope=tenant`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  // ---- revoke -------------------------------------------------------

  it('DELETE /auth/tokens/:id by owner → 200 + revokedAt + audit', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const mint = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'revokable', scopes: ['snipeit.compat.read'] }),
    });
    const { token } = (await mint.json()) as { token: { id: string } };

    const res = await fetch(`${url}/auth/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'laptop stolen' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedAt: string | null };
    expect(body.revokedAt).toBeTruthy();

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.pat.revoked', resourceId: token.id },
    });
    expect(audit).toBeTruthy();
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['reason']).toBe('laptop stolen');
    expect(meta['byOwner']).toBe(true);
  });

  it('DELETE /auth/tokens/:id by non-owner non-admin → 403', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const mint = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mine', scopes: ['snipeit.compat.read'] }),
    });
    const { token } = (await mint.json()) as { token: { id: string } };

    const otherCookie = await loginCookie(otherDriver.email, otherDriver.password);
    const res = await fetch(`${url}/auth/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /auth/tokens/:id by admin for someone else → 200 + byOwner:false', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const mint = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin-will-kill-this', scopes: ['snipeit.compat.read'] }),
    });
    const { token } = (await mint.json()) as { token: { id: string } };

    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/auth/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'compromised' }),
    });
    expect(res.status).toBe(200);

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.pat.revoked', resourceId: token.id },
    });
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['byOwner']).toBe(false);
  });

  it('DELETE /auth/tokens/:id idempotent — second delete also 200', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const mint = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'idempotent', scopes: ['snipeit.compat.read'] }),
    });
    const { token } = (await mint.json()) as { token: { id: string } };
    const first = await fetch(`${url}/auth/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${url}/auth/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(second.status).toBe(200);
  });

  // ---- rate limit ---------------------------------------------------

  it('11th mint by same user within the hour → 429', async () => {
    // Dedicated rate-limit user to isolate the Redis bucket from
    // other tests which also share the `driver` / `admin` buckets.
    const dedicatedEmail = 'rate-limit@pat-test.example';
    const password = 'correct-horse-battery-staple';
    const user = await adminDb.user.create({
      data: { email: dedicatedEmail, displayName: 'Rate Limit' },
    });
    await adminDb.authIdentity.create({
      data: {
        userId: user.id,
        provider: 'password',
        subject: dedicatedEmail,
        emailAtLink: dedicatedEmail,
        secretHash: await new PasswordService().hash(password),
      },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: user.id, role: 'driver', status: 'active' },
    });
    const cookie = await loginCookie(dedicatedEmail, password);

    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/auth/tokens`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `t-${i}`, scopes: ['snipeit.compat.read'] }),
      });
      expect(res.status).toBe(201);
    }
    const capped = await fetch(`${url}/auth/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 't-11', scopes: ['snipeit.compat.read'] }),
    });
    expect(capped.status).toBe(429);
    const body = (await capped.json()) as { error?: string; retryAfterSeconds?: number };
    expect(body.error).toBe('pat_issue_rate_limited');
    expect(typeof body.retryAfterSeconds).toBe('number');
  });
});
