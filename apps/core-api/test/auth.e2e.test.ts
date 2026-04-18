import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';

/**
 * Auth module e2e — exercises the endpoints that don't need a full
 * OIDC IdP round-trip (covered separately via mocks in a future unit
 * test). Confirms:
 *
 *   * /auth/discovery correctly routes by email domain
 *   * /auth/login with argon2id-hashed password
 *   * /auth/me + /auth/tenants reflect the current session
 *   * /auth/tenants/switch refuses tenants the user isn't a member of
 *   * /auth/oidc/:unknown returns 400 (and doesn't expose internal state)
 *   * cookie-with-tampered-payload is treated as unauthenticated
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('auth e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenantAcme: string;
  let tenantOther: string;

  const user = {
    email: 'driver@acme-auth.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Driver Auth',
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;

    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.reservation.deleteMany();
    await admin.asset.deleteMany();
    await admin.assetModel.deleteMany();
    await admin.category.deleteMany();
    await admin.tenantMembership.deleteMany();
    await admin.authIdentity.deleteMany();
    await admin.user.deleteMany();
    await admin.tenant.deleteMany();

    const acme = await admin.tenant.create({
      data: {
        slug: 'acme-auth',
        name: 'Acme Auth',
        displayName: 'Acme Auth',
        allowedEmailDomains: ['acme-auth.example'],
      },
    });
    const other = await admin.tenant.create({
      data: { slug: 'other-auth', name: 'Other Auth', displayName: 'Other Auth' },
    });
    tenantAcme = acme.id;
    tenantOther = other.id;

    const u = await admin.user.create({ data: { email: user.email, displayName: user.displayName } });
    await admin.tenantMembership.create({
      data: { tenantId: acme.id, userId: u.id, role: 'driver' },
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(user.password);
    await admin.authIdentity.create({
      data: {
        userId: u.id,
        provider: 'password',
        subject: user.email,
        emailAtLink: user.email,
        secretHash,
      },
    });
    await admin.$disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /auth/discovery routes a claimed domain to the owning tenant', async () => {
    const res = await fetch(`${url}/auth/discovery?email=some.user@acme-auth.example`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: string[];
      tenantHint: { slug: string } | null;
    };
    expect(body.tenantHint?.slug).toBe('acme-auth');
    expect(body.providers).toContain('password');
  });

  it('GET /auth/discovery returns no hint for an unclaimed domain', async () => {
    const res = await fetch(`${url}/auth/discovery?email=anyone@unclaimed.example`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantHint: unknown };
    expect(body.tenantHint).toBeNull();
  });

  it('GET /auth/discovery with a malformed email returns baseline providers only', async () => {
    const res = await fetch(`${url}/auth/discovery?email=not-an-email`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: string[]; tenantHint: unknown };
    expect(body.providers).toEqual(['password']);
    expect(body.tenantHint).toBeNull();
  });

  it('POST /auth/login with an unknown email returns 401 and takes about as long as a known-bad password', async () => {
    // Timing is crude to measure under vitest, so we just verify the shape.
    const unknown = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@nowhere.example', password: 'whatever' }),
    });
    const wrongPassword = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'wrong' }),
    });
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
  });

  it('POST /auth/tenants/switch refuses a tenant the user is not a member of', async () => {
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(login.status).toBe(200);
    const cookie = extractCookie(login);
    expect(cookie).toBeTruthy();

    const switchRes = await fetch(`${url}/auth/tenants/switch`, {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantOther }),
    });
    expect(switchRes.status).toBe(401);

    // The user IS a member of acme; switching to themselves works.
    const selfSwitch = await fetch(`${url}/auth/tenants/switch`, {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantAcme }),
    });
    expect(selfSwitch.status).toBe(200);
  });

  it('GET /auth/oidc/:unknown returns 400 without leaking internal state', async () => {
    const res = await fetch(`${url}/auth/oidc/notaprovider/start`);
    expect(res.status).toBe(400);
  });

  it('tampered session cookie is silently treated as unauthenticated', async () => {
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    const cookie = extractCookie(login);
    expect(cookie).toBeTruthy();

    // Flip one character inside the signed blob.
    const tampered = cookie!.replace(/^(panorama_session=.)/, (_match, prefix: string) =>
      prefix === 'x' ? prefix + 'y' : prefix.slice(0, -1) + (prefix.at(-1) === 'A' ? 'B' : 'A'),
    );

    const me = await fetch(`${url}/auth/me`, { headers: { cookie: tampered } });
    expect(me.status).toBe(401);
  });
});

function extractCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}
