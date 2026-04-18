import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { resetTestDb } from './_reset-db.js';

/**
 * Migration 0009 sanity — structural invariants the service layer
 * will depend on. Three things the code above us MUST be able to
 * assume are enforced at the DB:
 *
 *   1. `tokenHash` is uniquely indexed — a duplicate insert errors out.
 *   2. Cascading delete on tenant removes its tokens (no dangling FK).
 *   3. The resurrection trigger fires exactly when `revokedAt`
 *      transitions non-NULL → NULL, emitting a `panorama.pat.resurrected`
 *      audit row with metadata carrying tokenId / tokenPrefix / userId.
 *      Trigger does NOT fire on normal revocation (NULL → ts) or no-op
 *      updates.
 *
 * No Nest app — pure Prisma against the super-admin connection.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('migration 0009 — personal_access_tokens', () => {
  let db: PrismaClient;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(db);

    const tenant = await db.tenant.create({
      data: { slug: 'pat-mig-test', name: 'PAT Mig Test', displayName: 'PAT Mig Test' },
    });
    tenantId = tenant.id;
    const user = await db.user.create({
      data: { email: 'pat-mig@example.com', displayName: 'PAT Mig User' },
    });
    userId = user.id;
    await db.tenantMembership.create({
      data: { tenantId, userId, role: 'owner', status: 'active' },
    });
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  async function mkToken(overrides: Partial<{ revokedAt: Date | null }> = {}) {
    const bytes = randomBytes(32).toString('base64url');
    return db.personalAccessToken.create({
      data: {
        userId,
        tenantId,
        issuerUserId: userId,
        name: 'test-token',
        tokenHash: `hash-${bytes}`,
        tokenPrefix: `pnrm_pat_${bytes.slice(0, 8)}`,
        scopes: ['snipeit.compat.read'],
        revokedAt: overrides.revokedAt ?? null,
      },
    });
  }

  it('unique constraint on tokenHash rejects duplicates', async () => {
    const t = await mkToken();
    await expect(
      db.personalAccessToken.create({
        data: {
          userId,
          tenantId,
          issuerUserId: userId,
          name: 'dup',
          tokenHash: t.tokenHash, // same hash
          tokenPrefix: 'pnrm_pat_00000000',
          scopes: [],
        },
      }),
    ).rejects.toThrow(/Unique|tokenHash/);
  });

  it('revokedAt NULL → timestamp does NOT emit panorama.pat.resurrected', async () => {
    const t = await mkToken();
    const before = await db.auditEvent.count({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
    });
    await db.personalAccessToken.update({
      where: { id: t.id },
      data: { revokedAt: new Date() },
    });
    const after = await db.auditEvent.count({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
    });
    expect(after - before).toBe(0);
  });

  it('revokedAt timestamp → NULL emits panorama.pat.resurrected with metadata', async () => {
    const t = await mkToken({ revokedAt: new Date('2026-04-01T00:00:00Z') });
    const before = await db.auditEvent.count({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
    });

    await db.personalAccessToken.update({
      where: { id: t.id },
      data: { revokedAt: null },
    });

    const events = await db.auditEvent.findMany({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
      orderBy: { id: 'desc' },
    });
    expect(events.length - before).toBe(1);

    const ev = events[0]!;
    expect(ev.resourceType).toBe('personal_access_token');
    expect(ev.tenantId).toBe(tenantId);
    expect(ev.actorUserId).toBeNull(); // we don't know who did the direct UPDATE
    expect(ev.selfHash).toBeTruthy();

    const meta = (ev.metadata ?? {}) as Record<string, unknown>;
    expect(meta['tokenId']).toBe(t.id);
    expect(meta['tokenPrefix']).toBe(t.tokenPrefix);
    expect(meta['userId']).toBe(userId);
    expect(typeof meta['previousRevokedAt']).toBe('string');
  });

  it('no-op update on a live token (name change only) does not emit resurrection', async () => {
    const t = await mkToken();
    const before = await db.auditEvent.count({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
    });
    await db.personalAccessToken.update({
      where: { id: t.id },
      data: { name: 'renamed' },
    });
    const after = await db.auditEvent.count({
      where: { action: 'panorama.pat.resurrected', resourceId: t.id },
    });
    expect(after - before).toBe(0);
  });

  it('cascading delete: removing the tenant removes its tokens', async () => {
    // Separate tenant so we can delete it without nuking the outer
    // setup's (owner + cascade invariant 0007 requires >0 active owner
    // on the tenant being modified, not on unrelated tenants).
    const t2 = await db.tenant.create({
      data: { slug: 'pat-cascade', name: 'PAT Cascade', displayName: 'PAT Cascade' },
    });
    const u2 = await db.user.create({
      data: { email: 'pat-cascade@example.com', displayName: 'PAT Cascade User' },
    });
    await db.tenantMembership.create({
      data: { tenantId: t2.id, userId: u2.id, role: 'owner', status: 'active' },
    });
    const bytes = randomBytes(32).toString('base64url');
    const t = await db.personalAccessToken.create({
      data: {
        userId: u2.id,
        tenantId: t2.id,
        issuerUserId: u2.id,
        name: 'cascade-me',
        tokenHash: `hash-cascade-${bytes}`,
        tokenPrefix: `pnrm_pat_${bytes.slice(0, 8)}`,
        scopes: [],
      },
    });

    // Bypass the at-least-one-owner trigger so we can drop the tenant
    // (its single membership goes with it).
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL panorama.bypass_owner_check = 'on'");
      await tx.tenantMembership.deleteMany({ where: { tenantId: t2.id } });
      await tx.tenant.delete({ where: { id: t2.id } });
    });

    const stillThere = await db.personalAccessToken.findUnique({ where: { id: t.id } });
    expect(stillThere).toBeNull();
  });
});
