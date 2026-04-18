import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { PersonalAccessTokenService } from '../src/modules/auth/personal-access-token.service.js';
import { RedisService } from '../src/modules/redis/redis.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * SnipeitCompatModule + PatAuthGuard e2e (ADR-0010 step 5).
 *
 * Guard contract covered:
 *   * No Authorization header → 401 pat_required
 *   * Wrong Bearer prefix (e.g. not pnrm_pat_) → 401 pat_required
 *   * Unknown token hash → 401 invalid_token + audit panorama.pat.rejected
 *   * Revoked token → 401 invalid_token
 *   * Expired token → 401 invalid_token
 *   * Suspended membership → 401 user_suspended
 *   * Happy whoami → 200 + correct { userId, tenantId, tokenId }
 *   * First use emits panorama.pat.used_first + writes lastUsedAt
 *   * Second use does NOT re-emit used_first
 *   * PAT replayed against /invitations (native endpoint) → 401
 *     (SessionMiddleware suppression — the hard boundary)
 *   * Token with missing scope → 403 scope_required
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('snipeit compat — PatAuthGuard e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let pats: PersonalAccessTokenService;
  let redis: RedisService;
  let tenantId: string;
  let driverUserId: string;

  const driver = {
    email: 'driver@shim-auth.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Shim Auth Driver',
  };
  const admin = {
    email: 'admin@shim-auth.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Shim Auth Admin',
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

  async function mintPlaintext(overrides: {
    scopes?: string[];
    expiresAt?: Date | null;
  } = {}): Promise<{ plaintext: string; tokenId: string }> {
    const { token, plaintext } = await pats.mint({
      actor: { userId: driverUserId, tenantId },
      name: `test-${Math.random().toString(36).slice(2, 8)}`,
      scopes: overrides.scopes ?? ['snipeit.compat.read'],
      ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    });
    return { plaintext, tokenId: token.id };
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
    pats = app.get(PersonalAccessTokenService);
    redis = app.get(RedisService);

    const passwords = new PasswordService();
    const adminUser = await adminDb.user.create({
      data: { email: admin.email, displayName: admin.displayName },
    });
    const driverUser = await adminDb.user.create({
      data: { email: driver.email, displayName: driver.displayName },
    });
    driverUserId = driverUser.id;
    for (const [u, pw] of [
      [adminUser, admin.password],
      [driverUser, driver.password],
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
      slug: 'shim-auth',
      name: 'Shim Auth',
      displayName: 'Shim Auth',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driverUserId, role: 'driver', status: 'active' },
    });
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // ---- auth surface --------------------------------------------------

  it('GET /api/v1/whoami without Authorization → 401 pat_required', async () => {
    const res = await fetch(`${url}/api/v1/whoami`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pat_required');
  });

  it('GET /api/v1/whoami with wrong Bearer prefix → 401 pat_required', async () => {
    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: 'Bearer not-a-panorama-token' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pat_required');
  });

  it('GET /api/v1/whoami with unknown token hash → 401 invalid_token + audit', async () => {
    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: 'Bearer pnrm_pat_definitely-not-a-real-secret-abc' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.pat.rejected' },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['reason']).toBe('invalid_token');
    expect(String(meta['tokenPrefix'] ?? '')).toMatch(/^pnrm_pat_/);
  });

  it('GET /api/v1/whoami with revoked token → 401 invalid_token', async () => {
    const { plaintext, tokenId } = await mintPlaintext();
    await adminDb.personalAccessToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });
    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it('GET /api/v1/whoami with expired token → 401 invalid_token', async () => {
    // Mint a token with a valid future expiry, then force the column
    // into the past so `findByPlaintext` filters it out. `mint` itself
    // refuses past expiresAt at the service layer — this path tests
    // the middleware filter, not the DTO.
    const { plaintext, tokenId } = await mintPlaintext({
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await adminDb.personalAccessToken.update({
      where: { id: tokenId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/whoami with suspended membership → 401 user_suspended', async () => {
    const { plaintext } = await mintPlaintext();
    // Flip membership to suspended via direct DB edit.
    await adminDb.tenantMembership.update({
      where: { tenantId_userId: { tenantId, userId: driverUserId } },
      data: { status: 'suspended' },
    });
    try {
      const res = await fetch(`${url}/api/v1/whoami`, {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('user_suspended');
    } finally {
      await adminDb.tenantMembership.update({
        where: { tenantId_userId: { tenantId, userId: driverUserId } },
        data: { status: 'active' },
      });
      // Clear the 30s membership cache so subsequent tests re-read
      // from DB. Production code invalidates this key from the
      // TenantAdminService write path; direct-DB test edits bypass it.
      await redis.client.del(`pat:membership:${driverUserId}:${tenantId}`);
    }
  });

  it('GET /api/v1/whoami with a valid PAT → 200 + actor shape + panorama.pat.used_first', async () => {
    const { plaintext, tokenId } = await mintPlaintext();
    const before = await adminDb.auditEvent.count({
      where: { action: 'panorama.pat.used_first', resourceId: tokenId },
    });

    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      userId: string;
      tenantId: string;
      scopes: string[];
      tokenId: string;
    };
    expect(body.kind).toBe('pat');
    expect(body.userId).toBe(driverUserId);
    expect(body.tenantId).toBe(tenantId);
    expect(body.scopes).toContain('snipeit.compat.read');
    expect(body.tokenId).toBe(tokenId);

    const after = await adminDb.auditEvent.count({
      where: { action: 'panorama.pat.used_first', resourceId: tokenId },
    });
    expect(after - before).toBe(1);

    const row = await adminDb.personalAccessToken.findUnique({
      where: { id: tokenId },
    });
    expect(row?.lastUsedAt).toBeTruthy();
  });

  it('second call with the same PAT does NOT re-emit used_first', async () => {
    const { plaintext, tokenId } = await mintPlaintext();
    const r1 = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(r1.status).toBe(200);
    const firstCount = await adminDb.auditEvent.count({
      where: { action: 'panorama.pat.used_first', resourceId: tokenId },
    });
    expect(firstCount).toBe(1);

    const r2 = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(r2.status).toBe(200);
    const afterSecond = await adminDb.auditEvent.count({
      where: { action: 'panorama.pat.used_first', resourceId: tokenId },
    });
    expect(afterSecond).toBe(1);
  });

  // ---- module boundary ----------------------------------------------

  it('PAT against a native endpoint (/invitations) → 401, NOT silent fallback', async () => {
    // SessionMiddleware suppresses the session when a PAT Bearer header
    // is present, so native endpoints see no session and 401.
    const { plaintext } = await mintPlaintext();
    const res = await fetch(`${url}/invitations`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it('PAT AND session cookie attached together → native endpoint still 401 (PAT wins the suppression)', async () => {
    // Prove the suppression isn't hypothetical. A caller with BOTH a
    // valid session cookie and a PAT in the Bearer header must NOT
    // reach native endpoints via the session — ADR-0010 demands the
    // PAT-bearing request is treated as a compat-shim caller.
    const { plaintext } = await mintPlaintext();
    const cookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/invitations`, {
      headers: { cookie, authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  // ---- scope gate ---------------------------------------------------

  it('GET /api/v1/whoami with a token missing the required scope → 403 scope_required', async () => {
    // Service enforces the allowlist, so we can't mint with an empty
    // scope array via the public API. Insert directly to exercise the
    // ScopeGuard path.
    const row = await adminDb.personalAccessToken.create({
      data: {
        userId: driverUserId,
        tenantId,
        issuerUserId: driverUserId,
        name: 'no-scope',
        tokenHash: 'manually-inserted-hash-' + Math.random(),
        tokenPrefix: 'pnrm_pat_aaaaaaaa',
        scopes: [], // empty — should trip the ScopeGuard
      },
    });
    // We need a REAL plaintext that hashes to this row's tokenHash,
    // so that findByPlaintext returns it. Easier to patch the row's
    // tokenHash to match a known plaintext instead.
    const { createHash } = await import('node:crypto');
    const plaintext = 'pnrm_pat_scopeless-test-fixed-plaintext-1234';
    const hash = createHash('sha256').update(plaintext).digest('base64url');
    await adminDb.personalAccessToken.update({
      where: { id: row.id },
      data: { tokenHash: hash },
    });

    const res = await fetch(`${url}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(String(body.message ?? '')).toContain('scope_required');
  });
});
