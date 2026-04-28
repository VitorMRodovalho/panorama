import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Hash-chain integrity for batched `audit.recordWithin` calls
 * (tech-lead pass-2 soft on #140 + MaintenanceSweepService PM-due
 * audit batching, extended in #113 for the multi-strand reality).
 *
 * The invariant: when N rows are inserted via `recordWithin(tx, …)`
 * inside one transaction, row[k+1].prevHash MUST equal row[k].selfHash.
 * That holds today because Prisma transaction clients honour
 * read-your-own-writes within the same tx, so the `findFirst({
 * orderBy: { id: 'desc' } })` lookup at the top of `recordWithin`
 * sees the row inserted on the prior call. If a future Prisma upgrade
 * changes the tx-client snapshot semantics, this test catches it
 * before the chain breaks silently in production.
 *
 * Coverage:
 *   1. **Super-admin (global) strand** — five consecutive
 *      `recordWithin` calls in one super-admin tx; chain links
 *      forward, prevHash recomputable. Locks the global-strand
 *      invariant against Prisma upgrades.
 *   2. **Cross-batch global** — second super-admin batch in the same
 *      suite continues the chain (no per-tx reset).
 *   3. **Per-tenant strand (#113)** — three consecutive `recordWithin`
 *      calls under `runInTenant(tenantA, …)`. Under `panorama_app`
 *      the chain-head read is RLS-filtered to (tenantA + NULL), so
 *      the strand we observe back is what tenantA would see at
 *      verification time. Asserts the strand is internally coherent.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

interface AuditRowSlim {
  id: bigint;
  action: string;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  occurredAt: Date;
  prevHash: Buffer | null;
  selfHash: Buffer;
}

describe('audit hash-chain integrity — batched recordWithin', () => {
  let app: INestApplication;
  let adminDb: PrismaClient;
  let audit: AuditService;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    audit = app.get(AuditService);
    prisma = app.get(PrismaService);
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  it('chains hashes within a single batched tx + extends from prior tail', async () => {
    // Capture the current chain tail BEFORE the batch so we can verify
    // the first row of the batch links back to it (or is null when the
    // table is empty — `resetTestDb` truncates audit_events between
    // suites in the same run).
    const priorTail = await adminDb.auditEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { selfHash: true },
    });
    const priorTailHash: Buffer | null = priorTail?.selfHash ?? null;

    // Mark batch rows with a unique tenantId so we can SELECT them
    // back without matching unrelated audits emitted by the boot path.
    const batchTenantId = '00000000-0000-4000-8000-000000000044';
    const before = Date.now();

    await prisma.runAsSuperAdmin(
      async (tx) => {
        for (let i = 0; i < 5; i++) {
          await audit.recordWithin(tx, {
            action: `panorama.audit_chain_test.row_${i}`,
            resourceType: 'audit_chain_test',
            resourceId: `row-${i}`,
            tenantId: batchTenantId,
            actorUserId: null,
            metadata: { i },
          });
        }
      },
      { reason: 'audit_chain_test:batch' },
    );

    // Query the 5 batched rows back, ordered the way they were inserted.
    const rows = (await adminDb.auditEvent.findMany({
      where: { tenantId: batchTenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        action: true,
        tenantId: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
        occurredAt: true,
        prevHash: true,
        selfHash: true,
      },
    })) as unknown as AuditRowSlim[];

    expect(rows).toHaveLength(5);

    // The first row's prevHash must equal the chain tail captured
    // BEFORE the batch (or null if the chain was empty).
    if (priorTailHash === null) {
      expect(rows[0]!.prevHash).toBeNull();
    } else {
      expect(rows[0]!.prevHash).not.toBeNull();
      expect(Buffer.compare(rows[0]!.prevHash!, priorTailHash)).toBe(0);
    }

    // Each subsequent row's prevHash must match its predecessor's
    // selfHash. This is the load-bearing assertion for the
    // read-your-own-writes invariant — if Prisma ever changes
    // tx-client snapshot semantics, this fails.
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      expect(cur.prevHash).not.toBeNull();
      expect(Buffer.compare(cur.prevHash!, prev.selfHash)).toBe(0);
    }

    // selfHash recomputability: each row's selfHash must equal
    // sha256(prevHash || canonical_payload). If a downstream tool
    // tampers with any field — action, resourceId, tenantId, metadata,
    // occurredAt — the recomputed hash diverges and verification
    // tooling (when it ships) will catch it.
    for (const row of rows) {
      const payload = {
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        tenantId: row.tenantId,
        actorUserId: null as string | null,
        metadata: row.metadata ?? null,
        occurredAt: row.occurredAt.toISOString(),
      };
      const h = createHash('sha256');
      if (row.prevHash) h.update(row.prevHash);
      h.update(JSON.stringify(payload));
      const expected = h.digest();
      expect(Buffer.compare(row.selfHash, expected)).toBe(0);
    }

    // Sanity: occurredAt is within the test window.
    const after = Date.now();
    for (const row of rows) {
      expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(row.occurredAt.getTime()).toBeLessThanOrEqual(after + 1_000);
    }
  }, 30_000);

  it('a second batch in the same suite continues the chain', async () => {
    // Locks the regression: if the batch boundary somehow reset the
    // chain pointer (e.g., a future change introducing a per-tx
    // sequence start), the second batch's first row would link to
    // null instead of the prior batch's tail.
    const batchTenantId = '00000000-0000-4000-8000-000000000045';

    await prisma.runAsSuperAdmin(
      async (tx) => {
        for (let i = 0; i < 3; i++) {
          await audit.recordWithin(tx, {
            action: `panorama.audit_chain_test.batch2_${i}`,
            resourceType: 'audit_chain_test',
            resourceId: `b2-row-${i}`,
            tenantId: batchTenantId,
            actorUserId: null,
            metadata: { i },
          });
        }
      },
      { reason: 'audit_chain_test:batch2' },
    );

    const rows = (await adminDb.auditEvent.findMany({
      where: { tenantId: batchTenantId },
      orderBy: { id: 'asc' },
      select: { prevHash: true, selfHash: true },
    })) as unknown as Array<{ prevHash: Buffer | null; selfHash: Buffer }>;

    expect(rows).toHaveLength(3);
    // First row of batch 2 links to *some* prior tail (cannot be null
    // — the previous test's batch already extended the chain).
    expect(rows[0]!.prevHash).not.toBeNull();
    // Internal links remain coherent.
    for (let i = 1; i < rows.length; i++) {
      expect(Buffer.compare(rows[i]!.prevHash!, rows[i - 1]!.selfHash)).toBe(0);
    }
  }, 30_000);

  it('per-tenant strand under runInTenant chains coherently (#113)', async () => {
    // Documents + locks the multi-strand reality: under
    // `runInTenant(tenantA)` the `panorama_app` role's RLS policy
    // filters the chain-head read to (tenantA + NULL). The strand the
    // tenant observes back is what verification tooling will see at
    // audit time, so it must be internally coherent: every row's
    // prev_hash links to the previous row's self_hash within the same
    // batch.
    //
    // This does NOT assert linkage to the global super-admin strand —
    // those are separate strands by design (see AuditService docstring).
    const tenant = await createTenantForTest(adminDb, {
      slug: 'audit-chain-tenantA',
      name: 'Audit Chain Tenant A',
      displayName: 'Audit Chain Tenant A',
    });

    await prisma.runInTenant(tenant.id, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await audit.recordWithin(tx, {
          action: `panorama.audit_chain_test.tenant_strand_${i}`,
          resourceType: 'audit_chain_test',
          resourceId: `tenant-row-${i}`,
          tenantId: tenant.id,
          actorUserId: null,
          metadata: { i, strand: 'tenant' },
        });
      }
    });

    // Read back via the admin client (BYPASSRLS) so the test is not
    // itself constrained by the tenant's RLS view; the assertion is
    // about the rows we wrote, not about what the tenant can see.
    const rows = (await adminDb.auditEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { id: 'asc' },
      select: {
        action: true,
        prevHash: true,
        selfHash: true,
        tenantId: true,
      },
    })) as unknown as Array<{
      action: string;
      prevHash: Buffer | null;
      selfHash: Buffer;
      tenantId: string | null;
    }>;

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.tenantId).toBe(tenant.id);
    }
    // Internal chain coherence within the tenant strand.
    expect(rows[0]!.prevHash).not.toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(Buffer.compare(rows[i]!.prevHash!, rows[i - 1]!.selfHash)).toBe(0);
    }
  }, 30_000);
});
