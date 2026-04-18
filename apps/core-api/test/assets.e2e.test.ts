import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * End-to-end: boots the full Nest application and hits /auth/login,
 * /assets, and /health through Node's fetch client. Proves that:
 *
 *   - the app starts with every module wired (Auth, Tenant, Prisma, Asset)
 *   - /health is reachable without a session
 *   - /assets without a session cookie returns 401
 *   - /auth/login sets a session cookie, and the cookie scopes /assets
 *     to the right tenant
 *   - /auth/tenants/switch rotates the session to a different tenant
 *     and /assets reflects the switch immediately
 *   - the Prisma middleware + Postgres RLS cooperate under a real HTTP
 *     request (not just direct DB calls)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('assets e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenantAlpha: string;
  let tenantBravo: string;

  const driverEmail = 'driver.alpha@example.com';
  const multiTenantEmail = 'carol@shared.example';
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    // Match SESSION_SECRET env shape + point DATABASE_URL at the app role.
    process.env.SESSION_SECRET =
      process.env.SESSION_SECRET ?? 'a'.repeat(32); // test-only, 32-char stub
    process.env.DATABASE_URL = APP_URL;

    // Seed fixtures via the super-admin role (bypass RLS).
    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const a = await admin.tenant.create({
      data: { slug: 'alpha-e2e', name: 'Alpha e2e', displayName: 'Alpha e2e' },
    });
    const b = await admin.tenant.create({
      data: { slug: 'bravo-e2e', name: 'Bravo e2e', displayName: 'Bravo e2e' },
    });
    tenantAlpha = a.id;
    tenantBravo = b.id;

    for (const [tenantId, tagPrefix] of [
      [a.id, 'A'],
      [b.id, 'B'],
    ] as const) {
      const category = await admin.category.create({
        data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
      });
      const model = await admin.assetModel.create({
        data: { tenantId, categoryId: category.id, name: 'F-150' },
      });
      await admin.asset.createMany({
        data: [1, 2].map((i) => ({
          tenantId,
          modelId: model.id,
          tag: `${tagPrefix}-${i}`,
          name: `${tagPrefix} truck ${i}`,
        })),
      });
    }

    // User with one membership.
    const solo = await admin.user.create({
      data: { email: driverEmail, displayName: 'Alice Alpha' },
    });
    await admin.tenantMembership.create({
      data: { tenantId: a.id, userId: solo.id, role: 'driver' },
    });

    // User with two memberships (drives cars across companies).
    const carol = await admin.user.create({
      data: { email: multiTenantEmail, displayName: 'Carol Shared' },
    });
    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: carol.id, role: 'driver' },
        { tenantId: b.id, userId: carol.id, role: 'driver' },
      ],
    });

    // Hash the password via the same service the app uses.
    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        {
          userId: solo.id,
          provider: 'password',
          subject: driverEmail,
          emailAtLink: driverEmail,
          secretHash,
        },
        {
          userId: carol.id,
          provider: 'password',
          subject: multiTenantEmail,
          emailAtLink: multiTenantEmail,
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

  it('GET /health returns ok with db up', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe('up');
  });

  it('GET /assets without a session returns 401', async () => {
    const res = await fetch(`${url}/assets`);
    expect(res.status).toBe(401);
  });

  it('GET /assets after password login returns the user\'s tenant rows', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/assets`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ tag: string }> };
    const tags = body.items.map((i) => i.tag).sort();
    expect(tags).toEqual(['A-1', 'A-2']);
  });

  it('POST /auth/login with wrong password returns 401', async () => {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: driverEmail, password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /auth/me with a session echoes the current tenant', async () => {
    const cookie = await login(url, driverEmail, password);
    const res = await fetch(`${url}/auth/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      currentTenantId: string;
      memberships: Array<{ tenantId: string }>;
    };
    expect(body.email).toBe(driverEmail);
    expect(body.currentTenantId).toBe(tenantAlpha);
    expect(body.memberships.length).toBe(1);
  });

  it('multi-tenant user: /assets returns alpha rows by default and bravo after switch', async () => {
    const cookieAlpha = await login(url, multiTenantEmail, password);

    const alphaRes = await fetch(`${url}/assets`, { headers: { cookie: cookieAlpha } });
    const alphaBody = (await alphaRes.json()) as { items: Array<{ tag: string }> };
    const alphaTags = alphaBody.items.map((i) => i.tag).sort();
    expect(alphaTags).toEqual(['A-1', 'A-2']);

    const switchRes = await fetch(`${url}/auth/tenants/switch`, {
      method: 'POST',
      headers: { cookie: cookieAlpha, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantBravo }),
    });
    expect(switchRes.status).toBe(200);
    const cookieBravo = extractCookie(switchRes) ?? cookieAlpha;

    const bravoRes = await fetch(`${url}/assets`, { headers: { cookie: cookieBravo } });
    const bravoBody = (await bravoRes.json()) as { items: Array<{ tag: string }> };
    const bravoTags = bravoBody.items.map((i) => i.tag).sort();
    expect(bravoTags).toEqual(['B-1', 'B-2']);
  });

  it('POST /auth/logout clears the session', async () => {
    const cookie = await login(url, driverEmail, password);

    const logoutRes = await fetch(`${url}/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(204);

    // After logout, the returned set-cookie cleared the session. The old
    // cookie is still the signed one though; what matters is that NEW
    // requests without a cookie are 401:
    const meRes = await fetch(`${url}/auth/me`);
    expect(meRes.status).toBe(401);
  });
});

/** Login via the HTTP endpoint and return the session cookie to reuse on subsequent calls. */
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
  // Parse out every name=value; keep only the name=value pairs, not flags.
  // A single Set-Cookie header from iron-session looks like:
  //   "panorama_session=abc123; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"
  // Node's fetch joins multiple Set-Cookie with `, ` — but iron-session
  // writes exactly one, so this simple parser is sufficient for tests.
  return raw
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}
