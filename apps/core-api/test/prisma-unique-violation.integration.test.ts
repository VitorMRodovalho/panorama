import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPrismaClient } from '../src/modules/prisma/prisma-client.factory.js';
import { uniqueViolationOf } from '../src/modules/prisma/prisma-errors.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Prisma 7 error shape for a unique violation, against real Postgres
 * and through the real path: PrismaService.runInTenant on the app role
 * (panorama_app, NOBYPASSRLS, FORCE RLS). InvitationService relies on
 * `uniqueViolationOf` to turn the open-invitation race into a 409; a
 * Prisma 6 `meta.target` reader would silently stop matching here.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('unique violation shape under Prisma 7 (pg adapter + RLS)', () => {
  const admin = createPrismaClient(ADMIN_URL);
  const prisma = new PrismaService({ datasourceUrl: APP_URL, privilegedDatasourceUrl: ADMIN_URL });
  let tenantId: string;
  let inviterId: string;

  beforeAll(async () => {
    await resetTestDb(admin);
    const tenant = await createTenantForTest(admin, {
      slug: 'uv-shape',
      name: 'UV Shape',
      displayName: 'UV',
    });
    tenantId = tenant.id;
    const row = await admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { systemActorUserId: true },
    });
    inviterId = row.systemActorUserId!;
  }, 60_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await admin.$disconnect();
  });

  function openInvite(email: string) {
    return prisma.runInTenant(tenantId, (tx) =>
      tx.invitation.create({
        data: {
          tenantId,
          email,
          role: 'driver',
          tokenHash: randomBytes(16).toString('hex'),
          invitedByUserId: inviterId,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    );
  }

  it('names the partial unique index on a second open invitation', async () => {
    await openInvite('dup@uv-shape.example');
    let caught: unknown;
    try {
      await openInvite('dup@uv-shape.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationOf(caught)).toEqual({ index: 'invitations_one_open_per_tenant_email' });
  });

  it('names a different constraint for a different unique key (control)', async () => {
    const tokenHash = randomBytes(16).toString('hex');
    const data = {
      tenantId,
      role: 'driver',
      tokenHash,
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    await prisma.runInTenant(tenantId, (tx) =>
      tx.invitation.create({ data: { ...data, email: 'a@uv-shape.example' } }),
    );
    let caught: unknown;
    try {
      await prisma.runInTenant(tenantId, (tx) =>
        tx.invitation.create({ data: { ...data, email: 'b@uv-shape.example' } }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'P2002' });
    const violation = uniqueViolationOf(caught);
    expect(violation).toBeDefined();
    expect(violation?.index).not.toBe('invitations_one_open_per_tenant_email');
  });

  it('returns undefined for errors that are not P2002', () => {
    expect(uniqueViolationOf(new Error('nope'))).toBeUndefined();
    expect(uniqueViolationOf(undefined)).toBeUndefined();
  });
});
