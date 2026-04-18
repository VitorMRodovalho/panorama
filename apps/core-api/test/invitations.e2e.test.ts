import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';

/**
 * Invitation flow e2e (ADR-0008). Covers:
 *
 *   * create → 201 with plaintext token only surfaced on the response
 *   * open-dedupe: two creates for (tenant, email) → 409
 *   * revoke → 204; subsequent accept → state=invalid reason=revoked
 *   * resend → rotates token (old token stops working)
 *   * preview GET accept → 3 states (needs_login, email_mismatch, ready)
 *   * POST accept with matching session → membership created + session
 *     cookie rebuilt
 *   * POST accept twice — second call returns state=invalid reason=
 *     already_accepted (double-click race defended by conditional UPDATE)
 *   * expired invitation → state=invalid reason=expired
 *
 * The test imports AppModule directly, which brings up the BullMQ
 * worker. That's fine for the HTTP/DB assertions; the actual email
 * send to MailHog is out of scope (asserted indirectly via emailSentAt
 * reflection in a dedicated slow test). No Redis assertion here —
 * limits are tuned off in the dev env by default.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('invitation flow e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenantAcme: string;
  const admin = {
    email: 'admin@invitation-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Invitation Admin',
  };
  const targetEmail = 'newbie@invitation-test.example';
  const otherEmail = 'someone-else@invitation-test.example';
  const otherUser = {
    email: otherEmail,
    password: 'correct-horse-battery-staple',
    displayName: 'Different Person',
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;
    process.env.APP_BASE_URL = 'http://localhost:3000';
    // Turn off rate limits for the e2e run — dev has Redis, but
    // the test doesn't care about limit behavior here (covered by
    // a separate unit test when it lands).
    process.env.INVITE_RATE_ADMIN_HOUR = '10000';
    process.env.INVITE_RATE_TENANT_DAY = '100000';

    const adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminDb.invitation.deleteMany();
    await adminDb.reservation.deleteMany();
    await adminDb.asset.deleteMany();
    await adminDb.assetModel.deleteMany();
    await adminDb.category.deleteMany();
    await adminDb.tenantMembership.deleteMany();
    await adminDb.authIdentity.deleteMany();
    await adminDb.user.deleteMany();
    await adminDb.tenant.deleteMany();

    const tenant = await adminDb.tenant.create({
      data: {
        slug: 'invitation-test',
        name: 'Invitation Test',
        displayName: 'Invitation Test Tenant',
        allowedEmailDomains: ['invitation-test.example'],
      },
    });
    tenantAcme = tenant.id;

    const passwords = new PasswordService();
    const adminUser = await adminDb.user.create({
      data: { email: admin.email, displayName: admin.displayName },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId: tenant.id, userId: adminUser.id, role: 'fleet_admin' },
    });
    await adminDb.authIdentity.create({
      data: {
        userId: adminUser.id,
        provider: 'password',
        subject: admin.email,
        emailAtLink: admin.email,
        secretHash: await passwords.hash(admin.password),
      },
    });

    const other = await adminDb.user.create({
      data: { email: otherUser.email, displayName: otherUser.displayName },
    });
    // We give "other" their own tenant so /auth/login succeeds — the
    // session build refuses users with zero active memberships. In a
    // real invitation flow, their first tenant is seeded by accepting
    // an invite; we pre-seed a placeholder here to exercise the
    // email-mismatch path without needing OIDC wiring.
    const otherTenant = await adminDb.tenant.create({
      data: { slug: 'other-test', name: 'Other Test', displayName: 'Other Tenant' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: other.id, role: 'driver' },
    });
    await adminDb.authIdentity.create({
      data: {
        userId: other.id,
        provider: 'password',
        subject: otherUser.email,
        emailAtLink: otherUser.email,
        secretHash: await passwords.hash(otherUser.password),
      },
    });

    // And a user for the invitation target — already exists so the
    // happy-path accept doesn't need OIDC. The invitation links them
    // up via targetUserId on create.
    const target = await adminDb.user.create({
      data: { email: targetEmail, displayName: 'Newbie' },
    });
    const targetTenant = await adminDb.tenant.create({
      data: { slug: 'target-seed', name: 'Target Seed', displayName: 'Target Seed' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId: targetTenant.id, userId: target.id, role: 'driver' },
    });
    await adminDb.authIdentity.create({
      data: {
        userId: target.id,
        provider: 'password',
        subject: targetEmail,
        emailAtLink: targetEmail,
        secretHash: await passwords.hash(admin.password),
      },
    });
    await adminDb.$disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  // ---- helpers -------------------------------------------------------

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie');
    if (!set) throw new Error('no set-cookie from login');
    return set
      .split(',')
      .map((part) => part.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  async function createInvitation(
    adminCookie: string,
    email: string,
    role = 'driver',
  ): Promise<{
    status: number;
    body: {
      id: string;
      token: string;
      acceptUrl: string;
      email: string;
      role: string;
      expiresAt: string;
    } | { error: string; scope?: string };
  }> {
    const res = await fetch(`${url}/invitations`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantAcme, email, role }),
    });
    const body = (await res.json().catch(() => ({}))) as never;
    return { status: res.status, body };
  }

  // ---- tests ---------------------------------------------------------

  it('POST /invitations without session → 401', async () => {
    const res = await fetch(`${url}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantAcme, email: 'x@y.z', role: 'driver' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /invitations as admin → 201 with plaintext token + accept URL', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(cookie, 'fresh@invitation-test.example');
    expect(created.status).toBe(201);
    if (!('token' in created.body)) throw new Error('expected success body');
    expect(created.body.token).toHaveLength(43); // base64url of 32 bytes
    expect(created.body.acceptUrl).toMatch(/\/invitations\/accept\?t=/);
    expect(created.body.email).toBe('fresh@invitation-test.example');
  });

  it('POST /invitations for an email with an open invite → 409 open_invitation_exists', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const first = await createInvitation(cookie, 'dup@invitation-test.example');
    expect(first.status).toBe(201);
    const second = await createInvitation(cookie, 'dup@invitation-test.example');
    expect(second.status).toBe(409);
  });

  it('POST /invitations/:id/revoke → 204 and subsequent preview says revoked', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(cookie, 'revoke@invitation-test.example');
    if (!('token' in created.body)) throw new Error('expected success body');
    const id = created.body.id;
    const revokeRes = await fetch(`${url}/invitations/${id}/revoke`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(revokeRes.status).toBe(204);

    const preview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { state: string; reason?: string };
    expect(body.state).toBe('invalid');
    expect(body.reason).toBe('revoked');
  });

  it('POST /invitations/:id/resend → rotates token (old token becomes invalid)', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(cookie, 'resend@invitation-test.example');
    if (!('token' in created.body)) throw new Error('expected success body');
    const id = created.body.id;
    const oldToken = created.body.token;

    const resend = await fetch(`${url}/invitations/${id}/resend`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(resend.status).toBe(200);
    const { token: newToken } = (await resend.json()) as { token: string };
    expect(newToken).toHaveLength(43);
    expect(newToken).not.toBe(oldToken);

    const oldPreview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(oldToken)}`,
    );
    expect(oldPreview.status).toBe(200);
    const oldBody = (await oldPreview.json()) as { state: string };
    expect(oldBody.state).toBe('invalid');
    const newPreview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(newToken)}`,
    );
    expect(newPreview.status).toBe(200);
    const newBody = (await newPreview.json()) as { state: string };
    // Without a session, preview returns `needs_login` on the valid link.
    expect(newBody.state).toBe('needs_login');
  });

  it('GET /invitations/accept without session → needs_login with prefilled email', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(cookie, 'preview@invitation-test.example');
    if (!('token' in created.body)) throw new Error('expected success body');
    const preview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as {
      state: string;
      email: string;
      tenantDisplayName: string;
    };
    expect(body.state).toBe('needs_login');
    expect(body.email).toBe('preview@invitation-test.example');
    expect(body.tenantDisplayName).toBe('Invitation Test Tenant');
  });

  it('GET /invitations/accept with wrong-email session → email_mismatch', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(adminCookie, 'mismatch@invitation-test.example');
    if (!('token' in created.body)) throw new Error('expected success body');
    const otherCookie = await loginCookie(otherUser.email, otherUser.password);
    const preview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
      { headers: { cookie: otherCookie } },
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as {
      state: string;
      invitationEmail?: string;
      sessionEmail?: string;
    };
    expect(body.state).toBe('email_mismatch');
    expect(body.invitationEmail).toBe('mismatch@invitation-test.example');
    expect(body.sessionEmail).toBe(otherUser.email);
  });

  it('POST /invitations/accept with matching email → accepted + membership + refreshed session', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(adminCookie, targetEmail, 'fleet_staff');
    if (!('token' in created.body)) throw new Error('expected success body');

    const targetCookie = await loginCookie(targetEmail, admin.password);
    const accept = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
      {
        method: 'POST',
        headers: { cookie: targetCookie, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(accept.status).toBe(200);
    const body = (await accept.json()) as {
      state: string;
      tenantId?: string;
      role?: string;
    };
    expect(body.state).toBe('accepted');
    expect(body.tenantId).toBe(tenantAcme);
    expect(body.role).toBe('fleet_staff');
    // Session cookie was re-emitted — verify it decodes to a session
    // that now includes the new membership.
    const setCookie = accept.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const refreshedCookie = setCookie!
      .split(',')
      .map((p) => p.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');
    const me = await fetch(`${url}/auth/me`, { headers: { cookie: refreshedCookie } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      memberships: Array<{ tenantId: string; role: string }>;
    };
    const matched = meBody.memberships.find((m) => m.tenantId === tenantAcme);
    expect(matched?.role).toBe('fleet_staff');
  });

  it('POST /invitations/accept twice → second is invalid (already_accepted)', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(
      adminCookie,
      'double@invitation-test.example',
      'driver',
    );
    if (!('token' in created.body)) throw new Error('expected success body');

    // Seed a user for the invite so the accept can complete.
    const adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const user = await adminDb.user.create({
      data: { email: 'double@invitation-test.example', displayName: 'Double Click' },
    });
    const stageTenant = await adminDb.tenant.create({
      data: { slug: 'double-seed', name: 'Double Seed', displayName: 'Double Seed' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId: stageTenant.id, userId: user.id, role: 'driver' },
    });
    const passwords = new PasswordService();
    await adminDb.authIdentity.create({
      data: {
        userId: user.id,
        provider: 'password',
        subject: 'double@invitation-test.example',
        emailAtLink: 'double@invitation-test.example',
        secretHash: await passwords.hash(admin.password),
      },
    });
    await adminDb.$disconnect();

    const cookie = await loginCookie('double@invitation-test.example', admin.password);
    const first = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { state: string }).state).toBe('accepted');

    const second = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { state: string; reason?: string };
    expect(secondBody.state).toBe('invalid');
    expect(secondBody.reason).toBe('already_accepted');
  });

  it('expired invitation → preview returns invalid reason=expired', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(adminCookie, 'expired@invitation-test.example');
    if (!('token' in created.body)) throw new Error('expected success body');

    // Backdate expiresAt via super-admin DB client.
    const adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminDb.invitation.update({
      where: { id: created.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await adminDb.$disconnect();

    const preview = await fetch(
      `${url}/invitations/accept?t=${encodeURIComponent(created.body.token)}`,
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { state: string; reason?: string };
    expect(body.state).toBe('invalid');
    expect(body.reason).toBe('expired');
  });

  it('GET /invitations?tenantId= lists invitations for admin', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/invitations?tenantId=${tenantAcme}&status=all&limit=50`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ email: string; status: string }> };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('concurrent POST accept calls → exactly one wins (double-click race)', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const created = await createInvitation(
      adminCookie,
      'race@invitation-test.example',
      'driver',
    );
    if (!('token' in created.body)) throw new Error('expected success body');

    const adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const user = await adminDb.user.create({
      data: { email: 'race@invitation-test.example', displayName: 'Race Target' },
    });
    const raceTenant = await adminDb.tenant.create({
      data: { slug: 'race-seed', name: 'Race Seed', displayName: 'Race Seed' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId: raceTenant.id, userId: user.id, role: 'driver' },
    });
    const passwords = new PasswordService();
    await adminDb.authIdentity.create({
      data: {
        userId: user.id,
        provider: 'password',
        subject: 'race@invitation-test.example',
        emailAtLink: 'race@invitation-test.example',
        secretHash: await passwords.hash(admin.password),
      },
    });
    await adminDb.$disconnect();

    const cookie = await loginCookie('race@invitation-test.example', admin.password);
    const raceToken = created.body.token;
    const doIt = () =>
      fetch(`${url}/invitations/accept?t=${encodeURIComponent(raceToken)}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      }).then(async (r) => (await r.json()) as { state: string; reason?: string });

    const [a, b] = await Promise.all([doIt(), doIt()]);
    const states = [a.state, b.state].sort();
    // Exactly one accepted; the other sees the already-consumed state.
    expect(states).toEqual(['accepted', 'invalid']);
    const losing = [a, b].find((r) => r.state === 'invalid');
    expect(losing?.reason).toBe('already_accepted');
  });

  it('bad role is rejected with 400', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/invitations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenantAcme,
        email: 'badrole@invitation-test.example',
        role: 'god_mode',
      }),
    });
    expect(res.status).toBe(400);
  });
});
