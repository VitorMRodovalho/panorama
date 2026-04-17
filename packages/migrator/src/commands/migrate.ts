import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pino from 'pino';
import { SnipeItClient } from '../snipeit-client.js';
import { SnipeItUserSchema, SnipeItAssetSchema } from '../types.js';

export interface MigrateOptions {
  snipeitUrl: string;
  snipeitToken: string;
  fleetmanagerDump?: string;
  out: string;
  dryRun?: boolean;
  pageSize?: number;
}

/**
 * STATUS: scaffold-level. Reads users + assets from Snipe-IT and writes
 * Panorama fixture JSON files. Real schema + validation arrives in 0.2.
 *
 * The fixture format is **deliberately flat JSON per entity type** so an
 * operator can eyeball a dry-run output before running `panorama
 * import-fixtures`. We keep Snipe-IT IDs as `sourceSnipeitId` fields so
 * downstream rows (reservations, assignments) can resolve references
 * deterministically.
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

  // Users ----------------------------------------------------------------
  const rawUsers = await client.fetchAll<unknown>('users');
  const users = rawUsers
    .map((u) => SnipeItUserSchema.safeParse(u))
    .filter((r): r is { success: true; data: ReturnType<typeof SnipeItUserSchema.parse> } => r.success)
    .map((r) => r.data)
    .filter((u) => !!u.email)
    .map((u) => ({
      sourceSnipeitId: u.id,
      email: u.email!.toLowerCase().trim(),
      firstName: u.first_name ?? null,
      lastName: u.last_name ?? null,
      displayName: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username,
      activated: u.activated ?? true,
      isVip: !!u.vip,
      sourceCompanyId: u.company?.id ?? null,
      sourceCompanyName: u.company?.name ?? null,
      sourceGroupIds: (u.groups?.rows ?? []).map((g) => g.id),
    }));

  // Assets ---------------------------------------------------------------
  const rawAssets = await client.fetchAll<unknown>('hardware');
  const assets = rawAssets
    .map((a) => SnipeItAssetSchema.safeParse(a))
    .filter((r): r is { success: true; data: ReturnType<typeof SnipeItAssetSchema.parse> } => r.success)
    .map((r) => r.data)
    .map((a) => ({
      sourceSnipeitId: a.id,
      tag: a.asset_tag,
      name: a.name ?? a.asset_tag,
      serial: a.serial ?? null,
      sourceModelId: a.model?.id ?? null,
      sourceModelName: a.model?.name ?? null,
      sourceCategoryId: a.category?.id ?? null,
      sourceManufacturerId: a.manufacturer?.id ?? null,
      sourceCompanyId: a.company?.id ?? null,
      sourceLocationId: a.rtd_location?.id ?? null,
      sourceStatusLabelName: a.status_label?.name ?? null,
      customFields: a.custom_fields ?? {},
    }));

  // Companies, categories, manufacturers, locations, status labels ------
  // Kept as raw pass-through for now; 0.2 will transform them to Panorama
  // entities with tenant IDs and audit fields.
  const [companies, categories, manufacturers, locations, statuslabels] = await Promise.all([
    client.fetchAll<unknown>('companies'),
    client.fetchAll<unknown>('categories'),
    client.fetchAll<unknown>('manufacturers'),
    client.fetchAll<unknown>('locations'),
    client.fetchAll<unknown>('statuslabels'),
  ]);

  // Fixtures -------------------------------------------------------------
  const fixtures: Array<[string, unknown]> = [
    ['users.json', users],
    ['assets.json', assets],
    ['companies.raw.json', companies],
    ['categories.raw.json', categories],
    ['manufacturers.raw.json', manufacturers],
    ['locations.raw.json', locations],
    ['statuslabels.raw.json', statuslabels],
  ];

  for (const [name, data] of fixtures) {
    const path = join(outDir, name);
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
    const count = Array.isArray(data) ? data.length : 1;
    log.info({ path, count }, 'fixture_written');
  }

  // FleetManager dump - stub -------------------------------------------
  if (opts.fleetmanagerDump) {
    log.warn(
      { fleetmanagerDump: opts.fleetmanagerDump },
      'fleetmanager_dump_not_supported_yet — will parse reservations, inspections, and assignments in 0.3',
    );
  }

  if (opts.dryRun) {
    log.info('dry_run_complete — no imports performed');
  } else {
    log.warn(
      'real import path not implemented yet — run `panorama import-fixtures` (0.2) to load these JSON files',
    );
  }

  log.info({ users: users.length, assets: assets.length }, 'migrate_done');
}
