import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { runMigrate } from '@panorama/migrator';
import { ImportService } from '../src/modules/import/import.service.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * End-to-end migrator → fixtures → importer → Panorama DB.
 *
 * Boots a canned Snipe-IT mock on an ephemeral port, runs the migrator
 * against it to produce fixtures in a temp dir, then feeds those fixtures
 * to ImportService and asserts:
 *
 *   1. Every tenant, user, category, manufacturer, model, and asset
 *      landed in Postgres with the expected shape
 *   2. Users are deduped by email across tenants
 *   3. Re-running the importer produces zero `created` — full idempotency
 *   4. Tenant scoping is preserved: a second tenant's asset is NOT
 *      visible when querying as the first tenant
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

interface MockStore {
  companies: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  manufacturers: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
}

function buildMock(): MockStore {
  return {
    companies: [
      { id: 11, name: 'Alpha Logistics' },
      { id: 22, name: 'Bravo Transport' },
    ],
    users: [
      {
        id: 1001,
        username: 'alice',
        email: 'alice@alpha.example',
        first_name: 'Alice',
        last_name: 'Smith',
        company: { id: 11, name: 'Alpha Logistics' },
        groups: { rows: [{ id: 4, name: 'Fleet Admin' }] },
        vip: false,
      },
      {
        id: 1002,
        username: 'bob',
        email: 'bob@bravo.example',
        first_name: 'Bob',
        last_name: 'Jones',
        company: { id: 22, name: 'Bravo Transport' },
        groups: { rows: [{ id: 2, name: 'Drivers' }] },
        vip: true,
      },
      // Same email in two companies — tests the global-user / tenant-membership model
      {
        id: 1003,
        username: 'carol',
        email: 'carol@both.example',
        first_name: 'Carol',
        last_name: 'Shared',
        company: { id: 11, name: 'Alpha Logistics' },
        groups: { rows: [] },
      },
      {
        id: 1004,
        username: 'carol-b',
        email: 'carol@both.example', // duplicate email → one User, two memberships
        first_name: 'Carol',
        last_name: 'Shared',
        company: { id: 22, name: 'Bravo Transport' },
        groups: { rows: [] },
      },
    ],
    categories: [
      { id: 51, name: 'Vehicles', category_type: 'asset', company: { id: 11 } },
      { id: 52, name: 'Vehicles', category_type: 'asset', company: { id: 22 } },
    ],
    manufacturers: [{ id: 61, name: 'Ford', company: { id: 11 } }],
    models: [
      { id: 71, name: 'F-150 2024', category: { id: 51 }, manufacturer: { id: 61 }, company: { id: 11 } },
      { id: 72, name: 'F-150 2024', category: { id: 52 }, manufacturer: null, company: { id: 22 } },
    ],
    assets: [
      {
        id: 101,
        asset_tag: 'ALPHA-01',
        name: 'Alpha Truck 01',
        serial: 'SN-ALPHA-01',
        status_label: { id: 1, name: 'Ready to Deploy' },
        model: { id: 71 },
        company: { id: 11 },
      },
      {
        id: 102,
        asset_tag: 'ALPHA-02',
        name: 'Alpha Truck 02',
        serial: null,
        status_label: { id: 1, name: 'Ready to Deploy' },
        model: { id: 71 },
        company: { id: 11 },
      },
      {
        id: 201,
        asset_tag: 'BRAVO-01',
        name: 'Bravo Truck 01',
        serial: 'SN-BRAVO-01',
        status_label: { id: 2, name: 'VEH-Out of Service' },
        model: { id: 72 },
        company: { id: 22 },
      },
    ],
  };
}

function startMock(store: MockStore): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    const map: Record<string, Array<Record<string, unknown>>> = {
      companies: store.companies,
      users: store.users,
      categories: store.categories,
      manufacturers: store.manufacturers,
      models: store.models,
      hardware: store.assets,
    };
    const rows = map[path];
    if (!rows) {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'error', message: `unknown endpoint ${path}` }));
      return;
    }
    const slice = rows.slice(offset, offset + limit);
    res.end(JSON.stringify({ total: rows.length, rows: slice }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('migrator → import-fixtures round-trip', () => {
  let mock: { server: Server; baseUrl: string };
  let fixturesDir: string;
  let adminPrisma: PrismaClient;
  let importService: ImportService;

  beforeAll(async () => {
    process.env.DATABASE_URL = ADMIN_URL;

    // Fresh DB state — super_admin wipes; BYPASSRLS handles cross-tenant reach.
    adminPrisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminPrisma);

    mock = await startMock(buildMock());
    fixturesDir = await mkdtemp(join(tmpdir(), 'panorama-fixtures-'));

    // Produce canonical fixtures from the mock Snipe-IT
    await runMigrate({
      snipeitUrl: mock.baseUrl,
      snipeitToken: 'test-token',
      out: fixturesDir,
      dryRun: false,
    });

    // We bypass the Nest app bootstrap here — instantiate the service
    // directly against a PrismaService backed by the super_admin URL so
    // RLS is bypassed during the cross-tenant import. Other test files in
    // this suite may have left process.env.DATABASE_URL pointing at the
    // app role, so we pass an explicit datasourceUrl instead of relying
    // on env interpolation.
    const prisma = new PrismaService({ datasourceUrl: ADMIN_URL });
    importService = new ImportService(prisma);
  }, 30_000);

  afterAll(async () => {
    mock.server.close();
    await adminPrisma.$disconnect();
    // Cleanup for next test run
    process.env.DATABASE_URL = APP_URL;
  });

  it('imports the full fixture set end-to-end', async () => {
    const result = await importService.run({ dir: fixturesDir });
    expect(result.source).toBe('snipeit');
    // ADR-0007: imports from Snipe-IT never auto-elect an Owner.
    // Each tenant that lands without an `owner` membership shows up as
    // a non-fatal `tenant_has_no_active_owner` warning, expected to
    // be resolved post-import by the operator via the break-glass CLI
    // (see tenant-nominate-owner.ts).
    expect(result.errors.sort()).toEqual([
      'tenant_has_no_active_owner:alpha-logistics',
      'tenant_has_no_active_owner:bravo-transport',
    ]);

    expect(result.counts.tenants).toEqual({ created: 2, matched: 0 });
    // 4 sourceId → userId mappings, but only 3 unique rows in the users
    // table (carol's two source records reference the same User).
    expect(result.counts.users).toEqual({ created: 4, matched: 0 });
    // 3 imported users + 2 system actors (one per tenant per ADR-0016
    // §1 — required for auto-suggested maintenance audit attribution).
    const uniqueUsers = await adminPrisma.user.count();
    expect(uniqueUsers).toBe(5);
    const importedUsers = await adminPrisma.user.count({
      where: { email: { not: { startsWith: 'system+' } } },
    });
    expect(importedUsers).toBe(3);
    expect(result.counts.tenantMemberships).toEqual({ created: 4, matched: 0 });
    expect(result.counts.categories).toEqual({ created: 2, matched: 0 });
    expect(result.counts.manufacturers).toEqual({ created: 1, matched: 0 });
    expect(result.counts.assetModels).toEqual({ created: 2, matched: 0 });
    expect(result.counts.assets).toEqual({ created: 3, matched: 0 });
  });

  it('re-running is fully idempotent (everything matched, nothing created)', async () => {
    const result = await importService.run({ dir: fixturesDir });
    expect(result.counts.tenants).toEqual({ created: 0, matched: 2 });
    expect(result.counts.users).toEqual({ created: 0, matched: 4 });
    expect(result.counts.assets).toEqual({ created: 0, matched: 3 });
  });

  it('deduplicates users by email across tenants (one User, two memberships)', async () => {
    const carol = await adminPrisma.user.findUnique({
      where: { email: 'carol@both.example' },
      include: { memberships: { include: { tenant: true } } },
    });
    expect(carol).not.toBeNull();
    const tenantSlugs = carol!.memberships.map((m) => m.tenant.slug).sort();
    expect(tenantSlugs).toEqual(['alpha-logistics', 'bravo-transport']);
  });

  it('preserves tenant scoping — alpha assets belong to alpha only', async () => {
    const alphaTenant = await adminPrisma.tenant.findUnique({ where: { slug: 'alpha-logistics' } });
    const bravoTenant = await adminPrisma.tenant.findUnique({ where: { slug: 'bravo-transport' } });
    expect(alphaTenant).not.toBeNull();
    expect(bravoTenant).not.toBeNull();

    const alphaAssets = await adminPrisma.asset.findMany({
      where: { tenantId: alphaTenant!.id },
      select: { tag: true },
    });
    const bravoAssets = await adminPrisma.asset.findMany({
      where: { tenantId: bravoTenant!.id },
      select: { tag: true },
    });
    expect(alphaAssets.map((a) => a.tag).sort()).toEqual(['ALPHA-01', 'ALPHA-02']);
    expect(bravoAssets.map((a) => a.tag).sort()).toEqual(['BRAVO-01']);
  });

  it('maps Snipe-IT status labels to Panorama AssetStatus', async () => {
    const bravo = await adminPrisma.asset.findFirst({ where: { tag: 'BRAVO-01' } });
    expect(bravo?.status).toBe('MAINTENANCE');

    const alpha = await adminPrisma.asset.findFirst({ where: { tag: 'ALPHA-01' } });
    expect(alpha?.status).toBe('READY');
  });

  it('populates import_identity_map with (source, entity, sourceId) → UUID', async () => {
    const mapped = await adminPrisma.importIdentityMap.findMany({
      where: { source: 'snipeit', entity: 'asset' },
    });
    // 3 assets mapped
    expect(mapped.length).toBe(3);
    // Every row has a valid UUID
    for (const row of mapped) {
      expect(row.panoramaId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});
