import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Regression coverage for migration 0015 — Wave 1 data-layer
 * corrections. One file, four assertions per fix that observable
 * at the DB layer:
 *
 *   * #41 (DATA-03) — emit_notification_tamper_audit writes a
 *     non-NULL prevHash when audit_events has prior content.
 *   * #43 (DATA-05) — notification_events_dedup_unique with
 *     NULLS NOT DISTINCT rejects duplicate cluster events
 *     (tenantId IS NULL, same eventType + dedupKey).
 *   * #42 (DATA-04) — tenants_systemActorUserId_fkey is a real
 *     FK constraint that prevents deleting a User a tenant
 *     references.
 *   * #65 (PERF-06) — reservations_tenantId_onBehalfUserId_idx
 *     exists (sanity ping).
 *
 * #30 (DATA-02 / RLS GUC fix) is observable via the existing
 * tenancy.integration suite once an asset_maintenances row is
 * involved; tracking that case there is the right home.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('migration 0015 — Wave 1 corrections', () => {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    await resetTestDb(admin);
    const tenant = await createTenantForTest(admin, {
      slug: 'mig15',
      name: 'Mig15',
      displayName: 'Mig15',
    });
    tenantId = tenant.id;
    const tenantRow = await admin.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { systemActorUserId: true },
    });
    userId = tenantRow.systemActorUserId;
  }, 60_000);

  afterAll(async () => {
    await admin.$disconnect();
  });

  it('#42 — Tenant.systemActorUserId FK rejects deleting a referenced User', async () => {
    await expect(
      admin.user.delete({ where: { id: userId } }),
    ).rejects.toThrow();
  });

  it('#65 — reservations_tenantId_onBehalfUserId_idx exists', async () => {
    const rows = await admin.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'reservations_tenantId_onBehalfUserId_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('#43 — notification_events dedup rejects duplicates with tenantId IS NULL', async () => {
    const eventType = 'panorama.test.cluster_event';
    const dedupKey = `mig15-cluster-${Date.now()}`;
    await admin.notificationEvent.create({
      data: {
        tenantId: null,
        eventType,
        dedupKey,
        payload: { kind: 'first' },
      },
    });
    await expect(
      admin.notificationEvent.create({
        data: {
          tenantId: null,
          eventType,
          dedupKey,
          payload: { kind: 'second' },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('#43 — tenant-scoped dedup still rejects same (tenantId, eventType, dedupKey) (regression guard)', async () => {
    // Counter-test: confirm we did not invert the partial predicate
    // when adding NULLS NOT DISTINCT. The original (working) tenant
    // case must still collide.
    const eventType = 'panorama.test.tenant_event';
    const dedupKey = `mig15-tenant-${Date.now()}`;
    await admin.notificationEvent.create({
      data: { tenantId, eventType, dedupKey, payload: { kind: 'first' } },
    });
    await expect(
      admin.notificationEvent.create({
        data: { tenantId, eventType, dedupKey, payload: { kind: 'second' } },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('#41 — tamper-audit trigger writes a non-NULL prevHash when chain has content', async () => {
    // Seed the chain with at least one prior audit row. Use the
    // simplest path — write directly via super-admin (no domain
    // service involved), which gives us a guaranteed-present
    // prev row regardless of test order.
    await admin.auditEvent.create({
      data: {
        action: 'panorama.test.seed',
        resourceType: 'test',
        resourceId: 'seed-1',
        tenantId,
        actorUserId: null,
        occurredAt: new Date(),
        prevHash: null,
        selfHash: Buffer.from('seed-self-hash'.padEnd(32, 'x')),
      },
    });

    // Create a notification in PENDING then jump straight to
    // DISPATCHED — that's exactly the disallowed transition the
    // trigger watches for, so it fires and writes an audit row.
    const dedupKey = `mig15-tamper-${Date.now()}`;
    const created = await admin.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.test.tamper_target',
        dedupKey,
        payload: { kind: 'tamper-target' },
        status: 'PENDING',
      },
    });

    await admin.notificationEvent.update({
      where: { id: created.id },
      data: { status: 'DISPATCHED' },
    });

    const row = await admin.auditEvent.findFirst({
      where: { action: 'panorama.notification.status_tampered', resourceId: created.id },
      orderBy: { id: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row?.prevHash).not.toBeNull();
  });

  it('#41 — both audit triggers are SECURITY DEFINER (chain reads bypass per-tenant RLS strand)', async () => {
    // Without SECURITY DEFINER, the function runs under the
    // invoker's role and FORCE RLS on audit_events restricts the
    // SELECT to per-tenant + NULL rows — splitting the global
    // chain into per-tenant strands. SECURITY DEFINER + owner =
    // panorama (BYPASSRLS) keeps the chain global.
    //
    // Asserting the metadata on pg_proc is the deterministic check
    // that survives any future invoker scenario. The behavioural
    // check (prevHash non-NULL after a trigger fire) is covered by
    // the prior test.
    const rows = await admin.$queryRawUnsafe<{ proname: string; prosecdef: boolean }[]>(
      `SELECT proname, prosecdef FROM pg_proc
       WHERE proname IN ('emit_notification_tamper_audit', 'emit_pat_resurrected_audit')
       ORDER BY proname`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
    }
  });

  it('#41 — chain read is global (latest audit row visible regardless of tenant GUC)', async () => {
    // Multi-tenant proof: write a chain head in tenant T2, then
    // fire the notification trigger under tenant T1's GUC. With
    // SECURITY DEFINER + BYPASSRLS, the trigger's SELECT sees T2's
    // row as the global tail and links to it. Without SECURITY
    // DEFINER, the SELECT would be filtered to T1 + cluster and
    // miss T2's hash.
    const t2 = await createTenantForTest(admin, {
      slug: `mig15-t2-${Date.now()}`,
      name: 'Mig15 T2',
      displayName: 'Mig15 T2',
    });

    const tail = await admin.auditEvent.create({
      data: {
        action: 'panorama.test.global_tail',
        resourceType: 'test',
        resourceId: 'tail',
        tenantId: t2.id,
        actorUserId: null,
        occurredAt: new Date(),
        prevHash: null,
        selfHash: Buffer.from('global-tail-marker'.padEnd(32, 'z')),
      },
    });

    const dedupKey = `mig15-multi-${Date.now()}`;
    const created = await admin.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.test.multi_tenant_target',
        dedupKey,
        payload: { kind: 'multi-tenant-target' },
        status: 'PENDING',
      },
    });
    await admin.notificationEvent.update({
      where: { id: created.id },
      data: { status: 'DISPATCHED' },
    });

    const row = await admin.auditEvent.findFirst({
      where: { action: 'panorama.notification.status_tampered', resourceId: created.id },
      orderBy: { id: 'desc' },
    });
    expect(row?.prevHash).toEqual(tail.selfHash);
  });

  it('#41 / #96 — trigger digest: selfHash = sha256(prev_hash || utf8(canonical_payload))', async () => {
    // Pins the trigger function's hash math, not just its row-finding.
    // The chain-is-global test above proves the SECURITY DEFINER
    // SELECT walks audit_events without RLS scope; this test
    // recomputes the resulting selfHash byte-for-byte from the
    // payload Postgres builds via `json_build_object(...)::text`.
    //
    // Locks the digest contract against future trigger refactors:
    // any change to (a) the JSON payload key set, (b) the
    // occurredAt format string, or (c) the prepend-prev-hash byte
    // order would diverge the recomputed hash.
    //
    // Read `row.prevHash` AS WRITTEN by the trigger (whatever was
    // the global tail at fire time) and feed THAT into the
    // recomputation — no pre-condition on which row is the tail,
    // because vitest parallelism means another test file can race
    // an audit insert in between our seed and our fire.
    const dedupKey = `digest-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await admin.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.test.digest_target',
        dedupKey,
        payload: { kind: 'digest-target' },
        status: 'PENDING',
      },
    });
    // Disallowed transition fires the trigger.
    await admin.notificationEvent.update({
      where: { id: created.id },
      data: { status: 'DISPATCHED' },
    });

    const row = await admin.auditEvent.findFirstOrThrow({
      where: { action: 'panorama.notification.status_tampered', resourceId: created.id },
      orderBy: { id: 'desc' },
    });

    // Reconstruct the canonical payload Postgres built via
    // `json_build_object(...)::text`. Postgres emits `json` output
    // with whitespace around separators — `{"k" : v, "k2" : v2}` —
    // NOT the ECMA-404 compact form `JSON.stringify` produces. The
    // hash math is byte-sensitive, so the reconstruction has to
    // match that whitespace exactly.
    //
    // The occurredAt format mirrors the trigger's
    // `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` which is the
    // same shape `Date.toISOString()` emits. The trigger metadata
    // uses `json_build_object(fromStatus, toStatus, eventType)` —
    // key order is the SQL argument order, reproduced here.
    const payload = {
      action: 'panorama.notification.status_tampered',
      resourceType: 'notification_event',
      resourceId: created.id,
      tenantId,
      actorUserId: null,
      metadata: {
        fromStatus: 'PENDING',
        toStatus: 'DISPATCHED',
        eventType: 'panorama.test.digest_target',
      },
      occurredAt: row.occurredAt.toISOString(),
    };
    const payloadBytes = Buffer.from(pgJsonStringify(payload), 'utf8');

    const expected = createHash('sha256');
    if (row.prevHash) expected.update(row.prevHash);
    expected.update(payloadBytes);
    const expectedDigest = expected.digest();

    expect(row.selfHash.equals(expectedDigest)).toBe(true);
  });

  // The cutover marker (panorama.audit.chain_repair, action key) is
  // emitted at migration apply time. resetTestDb wipes audit_events
  // before every test run, so the marker is not present in the
  // running test DB by design — it only lives in production /
  // staging where audit_events accumulates from migration onward.
  // The marker's correctness is observable via the migration SQL
  // (its DO $$ block runs once when the migration applies); a
  // vitest assertion here would not survive resetTestDb's wipe.
});

/**
 * Postgres-compatible JSON serializer (#96). Postgres `json_build_object`
 * emits text with whitespace around separators:
 *   {"key" : "value", "k2" : null}
 * The trigger digests over those exact bytes, so reconstruction has
 * to match. ECMA-404 / `JSON.stringify` produces compact output
 * `{"key":"value","k2":null}` — different bytes, different sha256.
 *
 * Limited surface: handles the shapes the audit triggers emit
 * (strings, null, plain objects, no arrays/numbers/booleans). Not a
 * general-purpose serializer; throw on anything else so the test
 * fails loud if the trigger payload shape grows.
 */
function pgJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const pairs = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)} : ${pgJsonStringify(v)}`,
    );
    return `{${pairs.join(', ')}}`;
  }
  throw new Error(`pgJsonStringify: unsupported value type ${typeof value}`);
}
