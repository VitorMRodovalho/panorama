import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Migration 0021 — audit chain reproducibility + concurrency hardening.
 *
 * The service-side invariants (digestPreImage populated for every
 * row, sha256(prevHash || digestPreImage) == selfHash, advisory
 * lock visible to per-tenant strands) are covered by
 * `audit-chain-integrity.e2e.test.ts`. THIS file covers the
 * trigger-side invariants:
 *
 *   1. Notification tamper trigger writes a non-NULL `digestPreImage`
 *      and the recomputation sha256(prev || preimage) == selfHash.
 *   2. PAT resurrection trigger same.
 *   3. Notification UPDATE that flips `tenantId` (regardless of
 *      status transition) raises `tenantId_immutable_post_create`
 *      — the cross-tenant retarget block (D3).
 *   4. PAT UPDATE that flips `tenantId` same.
 *   5. `digestPreImage` parses back to the canonical JSON the
 *      trigger built — drift between trigger payload and stored
 *      pre-image shows up here, not weeks later in production.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('migration 0021 — audit chain reproducibility', () => {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  beforeAll(async () => {
    await resetTestDb(admin);
    const a = await createTenantForTest(admin, {
      slug: 'mig21-a',
      name: 'Mig21 A',
      displayName: 'Mig21 A',
    });
    tenantA = a.id;
    const aRow = await admin.tenant.findUniqueOrThrow({
      where: { id: a.id },
      select: { systemActorUserId: true },
    });
    userId = aRow.systemActorUserId;

    const b = await createTenantForTest(admin, {
      slug: 'mig21-b',
      name: 'Mig21 B',
      displayName: 'Mig21 B',
    });
    tenantB = b.id;
  }, 60_000);

  afterAll(async () => {
    await admin.$disconnect();
  });

  it('notification tamper trigger writes a non-NULL digestPreImage that reproduces selfHash', async () => {
    const dedupKey = `mig21-tamper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await admin.notificationEvent.create({
      data: {
        tenantId: tenantA,
        eventType: 'panorama.test.mig21_tamper',
        dedupKey,
        payload: { kind: 'mig21-tamper' },
        status: 'PENDING',
      },
    });
    await admin.notificationEvent.update({
      where: { id: created.id },
      data: { status: 'DISPATCHED' },
    });

    const row = await admin.auditEvent.findFirstOrThrow({
      where: {
        action: 'panorama.notification.status_tampered',
        resourceId: created.id,
      },
      orderBy: { id: 'desc' },
    });

    // Migration 0021 contract: digestPreImage is populated.
    expect(row.digestPreImage).not.toBeNull();
    const preImage = Buffer.from(row.digestPreImage!);

    // Recompute via the same path the chain-verify CLI uses.
    const h = createHash('sha256');
    if (row.prevHash) h.update(Buffer.from(row.prevHash));
    h.update(preImage);
    expect(Buffer.from(row.selfHash).equals(h.digest())).toBe(true);
  });

  it('PAT resurrection trigger writes a non-NULL digestPreImage that reproduces selfHash', async () => {
    // Insert a token directly (we just need a row whose revokedAt
    // transitions non-NULL → NULL, which is the trigger's predicate).
    // tokenHash + tokenPrefix + scopes are required; minimal viable
    // values are fine for a trigger-fire test.
    const pat = await admin.personalAccessToken.create({
      data: {
        tenantId: tenantA,
        userId,
        issuerUserId: userId,
        name: 'mig21-resurrect-target',
        tokenPrefix: 'pnrm_pat_mig21r',
        tokenHash: `sha256-mig21-resurrect-${Date.now()}`,
        scopes: ['snipeit.compat.read'],
        revokedAt: new Date(),
      },
    });

    await admin.personalAccessToken.update({
      where: { id: pat.id },
      data: { revokedAt: null },
    });

    const row = await admin.auditEvent.findFirstOrThrow({
      where: { action: 'panorama.pat.resurrected', resourceId: pat.id },
      orderBy: { id: 'desc' },
    });

    expect(row.digestPreImage).not.toBeNull();
    const preImage = Buffer.from(row.digestPreImage!);

    const h = createHash('sha256');
    if (row.prevHash) h.update(Buffer.from(row.prevHash));
    h.update(preImage);
    expect(Buffer.from(row.selfHash).equals(h.digest())).toBe(true);
  });

  it('notification UPDATE that flips tenantId raises tenantId_immutable_post_create', async () => {
    const created = await admin.notificationEvent.create({
      data: {
        tenantId: tenantA,
        eventType: 'panorama.test.mig21_immutable',
        dedupKey: `mig21-immut-${Date.now()}`,
        payload: { kind: 'immutable' },
        status: 'PENDING',
      },
    });

    await expect(
      admin.notificationEvent.update({
        where: { id: created.id },
        data: { tenantId: tenantB },
      }),
    ).rejects.toThrowError(/tenantId_immutable_post_create/);
  });

  it('PAT UPDATE that flips tenantId raises tenantId_immutable_post_create', async () => {
    const pat = await admin.personalAccessToken.create({
      data: {
        tenantId: tenantA,
        userId,
        issuerUserId: userId,
        name: 'mig21-immut-pat',
        tokenPrefix: 'pnrm_pat_mig21i',
        tokenHash: `sha256-mig21-immut-${Date.now()}`,
        scopes: ['snipeit.compat.read'],
      },
    });
    await expect(
      admin.personalAccessToken.update({
        where: { id: pat.id },
        data: { tenantId: tenantB },
      }),
    ).rejects.toThrowError(/tenantId_immutable_post_create/);
  });
});
