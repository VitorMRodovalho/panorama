import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import { SnipeItClient } from '../snipeit-client.js';
import { InventoryReportSchema, type InventoryReport, SnipeItUserSchema } from '../types.js';

export interface InventoryOptions {
  snipeitUrl: string;
  snipeitToken: string;
  out?: string;
  pageSize?: number;
}

const KNOWN_STATUS_LABEL_NAMES = new Set([
  'Ready to Deploy',
  'Deployed',
  'Pending',
  'Archived',
  'Broken',
  'Lost',
  'Out for Diagnostics',
  'Out for Repair',
  'Out for Maintenance',
  // Fleet-specific labels we expect from SnipeScheduler-FleetManager installs
  'VEH-Available',
  'VEH-In Service',
  'VEH-Out of Service',
  'VEH-Reserved',
]);

export async function runInventory(opts: InventoryOptions): Promise<InventoryReport> {
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const client = new SnipeItClient({
    baseUrl: opts.snipeitUrl,
    token: opts.snipeitToken,
    pageSize: opts.pageSize ?? 100,
    logger: log.child({ component: 'snipeit' }),
  });

  log.info({ snipeitUrl: opts.snipeitUrl }, 'inventory_start');

  // Counts — cheap one-page probes.
  const [
    assetCount,
    userCount,
    licenseCount,
    accessoryCount,
    consumableCount,
    componentCount,
    maintenanceCount,
    categoryCount,
    manufacturerCount,
    locationCount,
    companyCount,
    statusLabelCount,
    supplierCount,
    departmentCount,
  ] = await Promise.all([
    client.count('hardware'),
    client.count('users'),
    client.count('licenses'),
    client.count('accessories'),
    client.count('consumables'),
    client.count('components'),
    client.count('maintenances'),
    client.count('categories'),
    client.count('manufacturers'),
    client.count('locations'),
    client.count('companies'),
    client.count('statuslabels'),
    client.count('suppliers'),
    client.count('departments'),
  ]);

  // Deeper checks that require actual payloads.
  const users = await client.fetchAll<unknown>('users');
  const duplicateEmails = findDuplicateEmails(users);

  const statusLabelsResp = await client.get<{ rows?: { name?: string }[] }>(
    'statuslabels',
    { limit: 500 },
  );
  const unknownStatusLabels = (statusLabelsResp.rows ?? [])
    .map((row) => row.name ?? '')
    .filter((name) => name && !KNOWN_STATUS_LABEL_NAMES.has(name));

  const multiCompanyEnabled = companyCount > 1;
  const assetsWithNullCompany = multiCompanyEnabled
    ? await countAssetsWithNullCompany(client)
    : 0;

  const report: InventoryReport = InventoryReportSchema.parse({
    snipeitUrl: opts.snipeitUrl,
    generatedAt: new Date().toISOString(),
    counts: {
      hardware: assetCount,
      users: userCount,
      licenses: licenseCount,
      accessories: accessoryCount,
      consumables: consumableCount,
      components: componentCount,
      maintenances: maintenanceCount,
      categories: categoryCount,
      manufacturers: manufacturerCount,
      locations: locationCount,
      companies: companyCount,
      statuslabels: statusLabelCount,
      suppliers: supplierCount,
      departments: departmentCount,
    },
    flags: {
      duplicateEmails,
      unknownStatusLabels,
      multiCompanyEnabled,
      assetsWithNullCompany,
    },
  });

  if (opts.out) {
    const outPath = resolve(opts.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    log.info({ outPath }, 'inventory_written');
  }

  log.info(
    {
      totals: report.counts,
      duplicateEmails: duplicateEmails.length,
      unknownStatusLabels: unknownStatusLabels.length,
      multiCompanyEnabled,
      assetsWithNullCompany,
    },
    'inventory_done',
  );

  return report;
}

function findDuplicateEmails(rawUsers: unknown[]): string[] {
  const emailCounts = new Map<string, number>();
  for (const raw of rawUsers) {
    const parsed = SnipeItUserSchema.safeParse(raw);
    if (!parsed.success) continue;
    const email = parsed.data.email?.toLowerCase().trim();
    if (!email) continue;
    emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
  }
  return [...emailCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([email]) => email)
    .sort();
}

async function countAssetsWithNullCompany(client: SnipeItClient): Promise<number> {
  // Probe: the Snipe-IT API doesn't expose `company_id IS NULL` as a filter,
  // so we page all assets and count locally. Capped at a sane ceiling above.
  const assets = await client.fetchAll<{ company?: unknown }>('hardware');
  return assets.filter((a) => a.company === null || a.company === undefined).length;
}
