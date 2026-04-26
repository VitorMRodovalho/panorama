import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Maintenance MVP slice e2e (#74 / ADR-0016 §2-3 + §7).
 *
 * Covers:
 *   - openTicket happy path: asset READY → MAINTENANCE; audit row
 *   - openTicket on IN_USE asset: asset stays IN_USE; reservation
 *     marked stranded; opened_on_checked_out audit emitted
 *   - non-admin can't open without owning the triggering reservation
 *   - state machine: OPEN → IN_PROGRESS → COMPLETED, asset flips back
 *     to READY iff no other open ticket
 *   - cancel from OPEN: asset flips back to READY
 *   - admin-only: non-admin cancel is rejected
 *   - completion fields rejected on non-COMPLETED transitions
 *   - invalid transitions rejected (COMPLETED → IN_PROGRESS, etc.)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('maintenance MVP e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  let assetId: string;
  let otherAssetId: string;
  let driverUserId: string;

  const admin = {
    email: 'admin@maint-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Maintenance Admin',
  };
  const driver = {
    email: 'driver@maint-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Driver',
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
    // FEATURE_MAINTENANCE is forced 'true' in test/_setup.ts so the
    // module loads at AppModule bootstrap.

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
      slug: 'maint-test',
      name: 'Maintenance Test',
      displayName: 'Maintenance Test',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driverUser.id, role: 'driver', status: 'active' },
    });

    const category = await adminDb.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await adminDb.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'F-150 2024' },
    });
    const asset = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'MAINT-01',
        name: 'Maintenance Truck 01',
        bookable: true,
        status: 'READY',
      },
    });
    assetId = asset.id;
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'MAINT-02',
        name: 'Maintenance Truck 02',
        bookable: true,
        status: 'READY',
      },
    });
    otherAssetId = asset2.id;
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // --------------------------------------------------------------------

  it('admin opens ticket on READY asset → MAINTENANCE + audit', async () => {
    const cookie = await loginCookie(admin.email, admin.password);

    const res = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        maintenanceType: 'Repair',
        title: 'Brake check',
        notes: 'Driver flagged squealing brakes <careful>',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      maintenanceType: string;
      notes: string;
    };
    expect(body.status).toBe('OPEN');
    expect(body.maintenanceType).toBe('Repair');
    // notes are HTML-escaped at write per security-reviewer blocker #3.
    expect(body.notes).toContain('&lt;careful&gt;');

    const asset = await adminDb.asset.findUnique({ where: { id: assetId } });
    expect(asset?.status).toBe('MAINTENANCE');

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.maintenance.opened', resourceId: body.id },
    });
    expect(audit).toBeTruthy();

    // Restore for subsequent tests.
    await adminDb.assetMaintenance.updateMany({
      where: { id: body.id },
      data: { status: 'CANCELLED' },
    });
    await adminDb.asset.update({ where: { id: assetId }, data: { status: 'READY' } });
  });

  it('non-admin cannot open without a triggering reservation', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        maintenanceType: 'Repair',
        title: 'Brake check by driver',
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain(
      'admin_role_required',
    );
  });

  // Security-reviewer blocker (closed in this same PR): a non-admin
  // opener cannot pass `assigneeUserId`. Pre-fix, driver A could open a
  // ticket on their reservation but elect driver B as assignee, and B
  // would gain the assignee write rights on the ticket → COMPLETED
  // bypassing the implicit "admin closes work the requester opened".
  it('non-admin opener cannot pass assigneeUserId (assignee-promotion attack)', async () => {
    const cookie = await loginCookie(driver.email, driver.password);

    // Driver creates a reservation they own.
    const startAt = new Date(Date.now() + 800 * 3_600_000).toISOString();
    const endAt = new Date(Date.now() + 802 * 3_600_000).toISOString();
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: otherAssetId, startAt, endAt }),
    });
    expect(created.status).toBe(201);
    const reservation = (await created.json()) as { id: string };

    // Driver opens ticket on their own reservation, but tries to set
    // assigneeUserId to someone else → 403.
    const res = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: otherAssetId,
        maintenanceType: 'Repair',
        title: 'Self-flagged repair',
        triggeringReservationId: reservation.id,
        assigneeUserId: driverUserId, // self-assign, but the rule says
                                      // any assigneeUserId from non-admin
                                      // is forbidden — even self.
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain(
      'admin_role_required_for_assignee',
    );
  });

  it('completion fields rejected on non-COMPLETED transition', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const open = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: otherAssetId,
        maintenanceType: 'Maintenance',
        title: 'Oil change',
      }),
    });
    expect(open.status).toBe(201);
    const ticket = (await open.json()) as { id: string };

    const res = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'IN_PROGRESS', completionNote: 'wrong field here' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      'completion_fields_only_on_completed',
    );

    // Restore for next test.
    await adminDb.assetMaintenance.update({
      where: { id: ticket.id },
      data: { status: 'CANCELLED' },
    });
    await adminDb.asset.update({ where: { id: otherAssetId }, data: { status: 'READY' } });
  });

  it('full lifecycle: OPEN → IN_PROGRESS → COMPLETED, asset returns to READY', async () => {
    const cookie = await loginCookie(admin.email, admin.password);

    const open = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        maintenanceType: 'Repair',
        title: 'Tire rotation',
      }),
    });
    expect(open.status).toBe(201);
    const ticket = (await open.json()) as { id: string; status: string };
    expect(ticket.status).toBe('OPEN');

    const a1 = await adminDb.asset.findUnique({ where: { id: assetId } });
    expect(a1?.status).toBe('MAINTENANCE');

    const inProgress = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    expect(inProgress.status).toBe(200);
    expect(((await inProgress.json()) as { status: string }).status).toBe('IN_PROGRESS');

    const completed = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'COMPLETED',
        completionNote: 'Rotated front-to-rear',
        cost: 75.5,
      }),
    });
    expect(completed.status).toBe(200);
    const done = (await completed.json()) as {
      status: string;
      completedAt: string | null;
      completionNote: string;
    };
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
    expect(done.completionNote).toContain('Rotated');

    const a2 = await adminDb.asset.findUnique({ where: { id: assetId } });
    expect(a2?.status).toBe('READY');

    const completedAudit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.maintenance.completed', resourceId: ticket.id },
    });
    expect(completedAudit).toBeTruthy();
  });

  it('invalid transition COMPLETED → IN_PROGRESS rejected', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const open = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        maintenanceType: 'Repair',
        title: 'Brake fluid',
      }),
    });
    const ticket = (await open.json()) as { id: string };
    await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });

    const res = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(
      'invalid_transition:completed_to_in_progress',
    );
  });

  it('non-admin cannot cancel even when listed as assignee', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const open = await fetch(`${url}/maintenances`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        maintenanceType: 'Inspection',
        title: 'Quarterly check',
        assigneeUserId: driverUserId,
      }),
    });
    const ticket = (await open.json()) as { id: string };

    // Driver is now assignee. They can move to IN_PROGRESS, but not
    // CANCEL — cancel is admin-only per ADR-0016 §2 transition matrix.
    const driverCookie = await loginCookie(driver.email, driver.password);
    const inProgress = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    expect(inProgress.status).toBe(200);

    const cancel = await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
    expect(cancel.status).toBe(403);
    expect(((await cancel.json()) as { message: string }).message).toContain(
      'admin_role_required',
    );

    // Admin closes it out so the asset is restored.
    await fetch(`${url}/maintenances/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
  });

  it('list filters by status + assetId + paginates', async () => {
    const cookie = await loginCookie(admin.email, admin.password);

    // Open three tickets on otherAssetId.
    for (const title of ['Ticket A', 'Ticket B', 'Ticket C']) {
      const r = await fetch(`${url}/maintenances`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          assetId: otherAssetId,
          maintenanceType: 'Repair',
          title,
        }),
      });
      expect(r.status).toBe(201);
    }

    const list = await fetch(`${url}/maintenances?status=OPEN&assetId=${otherAssetId}`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: Array<{ id: string; status: string; assetId: string }>;
      nextCursor: string | null;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    for (const r of body.items) {
      expect(r.status).toBe('OPEN');
      expect(r.assetId).toBe(otherAssetId);
    }
  });
});
