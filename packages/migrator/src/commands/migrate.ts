import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pino from 'pino';
import {
  FIXTURE_FILES,
  FIXTURE_SCHEMA_VERSION,
  type AssetFixture,
  type AssetModelFixture,
  type CategoryFixture,
  type Manifest,
  type ManufacturerFixture,
  type TenantFixture,
  type TenantMembershipFixture,
  type UserFixture,
} from '@panorama/shared';
import { SnipeItClient } from '../snipeit-client.js';
import { SnipeItUserSchema, SnipeItAssetSchema } from '../types.js';

export interface MigrateOptions {
  snipeitUrl: string;
  snipeitToken: string;
  fleetmanagerDump?: string;
  out: string;
  dryRun?: boolean;
  pageSize?: number;
  /** Slug to use when Snipe-IT has no companies (single-tenant install). */
  defaultTenantSlug?: string;
}

/**
 * Read a Snipe-IT install via its API and write Panorama fixture JSON
 * files to --out in the canonical shape consumed by the core-api's
 * ImportService. The shapes are defined in @panorama/shared/migration-fixtures.
 *
 * Design constraints:
 *   - Read-only against the source Snipe-IT.
 *   - Idempotent output: rerunning overwrites each fixture file with the
 *     current state of Snipe-IT. Import is idempotent on its side via
 *     the import_identity_map table.
 *   - Every entity is tagged with `source: 'snipeit'` + `sourceId:
 *     String(id)` so the importer can resolve cross-entity FKs.
 *   - When Snipe-IT has no companies (single-company install), we emit
 *     one synthetic tenant `default-tenant` so downstream FKs work.
 */
export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const client = new SnipeItClient({
    baseUrl: opts.snipeitUrl,
    token: opts.snipeitToken,
    pageSize: opts.pageSize ?? 100,
    logger: log.child({ component: 'snipeit' }),
  });

  const outDir = resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  log.info({ outDir, dryRun: !!opts.dryRun }, 'migrate_start');

  const rawCompanies = (await client.fetchAll<{ id: number; name: string }>('companies')) ?? [];
  const rawUsers = await client.fetchAll<unknown>('users');
  const rawCategories = (await client.fetchAll<{
    id: number;
    name: string;
    category_type?: string;
    company?: { id: number } | null;
  }>('categories')) ?? [];
  const rawManufacturers = (await client.fetchAll<{
    id: number;
    name: string;
    url?: string | null;
    support_email?: string | null;
    support_phone?: string | null;
    company?: { id: number } | null;
  }>('manufacturers')) ?? [];
  const rawModels = (await client.fetchAll<{
    id: number;
    name: string;
    model_number?: string | null;
    image?: string | null;
    category?: { id: number } | null;
    manufacturer?: { id: number } | null;
    company?: { id: number } | null;
  }>('models')) ?? [];
  const rawAssets = await client.fetchAll<unknown>('hardware');

  // ----------------------------------------------------------------
  // Tenants — from Snipe-IT companies, or a synthetic default.
  // ----------------------------------------------------------------
  const tenantFixtures: TenantFixture[] = [];
  if (rawCompanies.length === 0) {
    const slug = opts.defaultTenantSlug ?? 'default-tenant';
    tenantFixtures.push({
      source: 'snipeit',
      sourceId: '__default__',
      slug,
      name: 'Default tenant',
      displayName: 'Default tenant',
      locale: 'en',
      timezone: 'UTC',
    });
  } else {
    for (const c of rawCompanies) {
      tenantFixtures.push({
        source: 'snipeit',
        sourceId: String(c.id),
        slug: slugify(c.name, `tenant-${c.id}`),
        name: c.name,
        displayName: c.name,
        locale: 'en',
        timezone: 'UTC',
      });
    }
  }
  const fallbackTenantSourceId =
    rawCompanies.length === 0 ? '__default__' : String(rawCompanies[0]?.id ?? 1);

  const companyIdForEntity = (
    entityCompany: { id?: number | undefined } | null | undefined,
  ): string => {
    if (entityCompany && typeof entityCompany.id === 'number') return String(entityCompany.id);
    return fallbackTenantSourceId;
  };

  // ----------------------------------------------------------------
  // Users + memberships — users are global; memberships carry the tenant.
  // Same email across two Snipe-IT records: ImportService dedupes users
  // by email and records both sourceIds in import_identity_map.
  // ----------------------------------------------------------------
  const userFixtures: UserFixture[] = [];
  const membershipFixtures: TenantMembershipFixture[] = [];

  for (const raw of rawUsers) {
    const parsed = SnipeItUserSchema.safeParse(raw);
    if (!parsed.success) continue;
    const u = parsed.data;
    if (!u.email) continue;

    const email = u.email.toLowerCase().trim();
    const sourceId = String(u.id);
    const displayName =
      [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || email;

    userFixtures.push({
      source: 'snipeit',
      sourceId,
      email,
      firstName: u.first_name ?? null,
      lastName: u.last_name ?? null,
      displayName,
    });

    const tenantSourceId = companyIdForEntity(u.company);
    membershipFixtures.push({
      source: 'snipeit',
      sourceUserId: sourceId,
      sourceTenantId: tenantSourceId,
      role: resolveRoleFromGroups(u.groups?.rows ?? []),
      isVip: !!u.vip,
    });
  }

  // ----------------------------------------------------------------
  // Catalog
  // ----------------------------------------------------------------
  const categoryFixtures: CategoryFixture[] = rawCategories.map((c) => ({
    source: 'snipeit',
    sourceId: String(c.id),
    sourceTenantId: companyIdForEntity(c.company),
    name: c.name,
    kind: inferCategoryKind(c.category_type ?? c.name),
  }));

  const manufacturerFixtures: ManufacturerFixture[] = rawManufacturers.map((m) => ({
    source: 'snipeit',
    sourceId: String(m.id),
    sourceTenantId: companyIdForEntity(m.company),
    name: m.name,
    url: m.url ?? null,
    supportEmail: m.support_email ?? null,
    supportPhone: m.support_phone ?? null,
  }));

  const assetModelFixtures: AssetModelFixture[] = rawModels
    .filter((m) => m.category && typeof m.category.id === 'number')
    .map((m) => ({
      source: 'snipeit',
      sourceId: String(m.id),
      sourceTenantId: companyIdForEntity(m.company),
      sourceCategoryId: String(m.category!.id),
      sourceManufacturerId: m.manufacturer ? String(m.manufacturer.id) : null,
      name: m.name,
      modelNumber: m.model_number ?? null,
      imageUrl: m.image ?? null,
    }));

  const assetFixtures: AssetFixture[] = [];
  for (const raw of rawAssets) {
    const parsed = SnipeItAssetSchema.safeParse(raw);
    if (!parsed.success) continue;
    const a = parsed.data;
    if (!a.model || typeof a.model.id !== 'number') continue;

    const status = inferAssetStatus(a.status_label?.name ?? null);
    assetFixtures.push({
      source: 'snipeit',
      sourceId: String(a.id),
      sourceTenantId: companyIdForEntity(a.company),
      sourceModelId: String(a.model.id),
      tag: a.asset_tag,
      name: a.name ?? a.asset_tag,
      serial: a.serial ?? null,
      status,
      bookable: false,
      customFields: (a.custom_fields as Record<string, unknown>) ?? {},
    });
  }

  // ----------------------------------------------------------------
  // Write manifest + per-entity files.
  // ----------------------------------------------------------------
  const manifest: Manifest = {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    source: 'snipeit',
    sourceUrl: opts.snipeitUrl,
    generatedAt: new Date().toISOString(),
    counts: {
      tenants: tenantFixtures.length,
      users: userFixtures.length,
      tenantMemberships: membershipFixtures.length,
      categories: categoryFixtures.length,
      manufacturers: manufacturerFixtures.length,
      assetModels: assetModelFixtures.length,
      assets: assetFixtures.length,
    },
  };

  const writes: Array<[string, unknown]> = [
    [FIXTURE_FILES.manifest, manifest],
    [FIXTURE_FILES.tenants, tenantFixtures],
    [FIXTURE_FILES.users, userFixtures],
    [FIXTURE_FILES.tenantMemberships, membershipFixtures],
    [FIXTURE_FILES.categories, categoryFixtures],
    [FIXTURE_FILES.manufacturers, manufacturerFixtures],
    [FIXTURE_FILES.assetModels, assetModelFixtures],
    [FIXTURE_FILES.assets, assetFixtures],
  ];

  for (const [file, data] of writes) {
    await writeFile(join(outDir, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
    const count = Array.isArray(data) ? data.length : 1;
    log.info({ file, count }, 'fixture_written');
  }

  if (opts.fleetmanagerDump) {
    log.warn(
      { fleetmanagerDump: opts.fleetmanagerDump },
      'fleetmanager_dump_not_supported_yet — will parse reservations, inspections, and assignments in 0.3',
    );
  }

  log.info(
    {
      dryRun: !!opts.dryRun,
      tenants: tenantFixtures.length,
      users: userFixtures.length,
      assets: assetFixtures.length,
    },
    'migrate_done',
  );

  if (opts.dryRun) {
    log.info('dry_run_complete — fixtures written; no import performed');
  } else {
    log.warn(
      'import path: `pnpm --filter @panorama/core-api exec tsx src/scripts/import-fixtures.ts --dir <out>`',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s && /^[a-z0-9]/.test(s) ? s : fallback;
}

function resolveRoleFromGroups(
  groups: Array<{ id: number; name: string }>,
): TenantMembershipFixture['role'] {
  const names = groups.map((g) => g.name.toLowerCase());
  if (names.some((n) => n.includes('super') && n.includes('admin'))) return 'super_admin';
  if (names.some((n) => n.includes('fleet admin'))) return 'fleet_admin';
  if (names.some((n) => n.includes('fleet staff'))) return 'fleet_staff';
  return 'driver';
}

function inferCategoryKind(hint: string | null | undefined): CategoryFixture['kind'] {
  const v = (hint ?? '').toLowerCase();
  if (v.includes('vehicle') || v.includes('veh-') || v.includes('car') || v.includes('truck'))
    return 'VEHICLE';
  if (v.includes('license')) return 'LICENSE';
  if (v.includes('accessor')) return 'ACCESSORY';
  if (v.includes('consum')) return 'CONSUMABLE';
  if (v.includes('component')) return 'COMPONENT';
  if (v.includes('hardware') || v.includes('asset') || v === 'asset') return 'HARDWARE';
  return 'OTHER';
}

function inferAssetStatus(name: string | null): AssetFixture['status'] {
  const v = (name ?? '').toLowerCase();
  if (v.includes('in service') || v.includes('deployed')) return 'IN_USE';
  if (v.includes('reserved')) return 'RESERVED';
  if (v.includes('maintenance') || v.includes('out of service') || v.includes('repair'))
    return 'MAINTENANCE';
  if (v.includes('retired') || v.includes('archived')) return 'RETIRED';
  return 'READY';
}
