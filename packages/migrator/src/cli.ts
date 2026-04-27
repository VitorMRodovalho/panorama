#!/usr/bin/env node
import { Command } from 'commander';
import { runInventory } from './commands/inventory.js';
import { runMigrate } from './commands/migrate.js';

const program = new Command();

program
  .name('panorama-migrate')
  .description('Read Snipe-IT (+ optional FleetManager dump) and produce Panorama fixtures.')
  .version('0.0.0');

// Commander's .action(cb) receives parsed opts as `any` because the
// option-shape is declared via fluent .option(...) calls, not a static
// type. Hand-type the shapes here so the rest of the file stays under
// `no-unsafe-*` lint without `// eslint-disable` lines.
interface InventoryOpts {
  snipeitUrl: string;
  snipeitToken: string;
  out?: string;
  pageSize: number;
}

interface MigrateOpts {
  snipeitUrl: string;
  snipeitToken: string;
  fleetmanagerDump?: string;
  out: string;
  dryRun: boolean;
  pageSize: number;
}

program
  .command('inventory')
  .description('Count entities in a Snipe-IT install and flag migration risks')
  .requiredOption('--snipeit-url <url>', 'Snipe-IT base URL (no trailing /api/v1)')
  .requiredOption('--snipeit-token <token>', 'Snipe-IT API token')
  .option('--out <path>', 'Optional JSON output path')
  .option('--page-size <n>', 'Page size for paginated endpoints', (v) => parseInt(v, 10), 100)
  .action(async (opts: InventoryOpts) => {
    try {
      // `exactOptionalPropertyTypes: true` (tsconfig.base) refuses
      // `{ out: undefined }` for a `{ out?: string }` parameter; spread
      // only when defined so the optional/missing distinction stays
      // crisp at the call site.
      await runInventory({
        snipeitUrl: opts.snipeitUrl,
        snipeitToken: opts.snipeitToken,
        ...(opts.out !== undefined ? { out: opts.out } : {}),
        pageSize: opts.pageSize,
      });
    } catch (err) {
      console.error('inventory failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('migrate')
  .description('Read Snipe-IT + optional FleetManager dump, write Panorama fixtures')
  .requiredOption('--snipeit-url <url>', 'Snipe-IT base URL')
  .requiredOption('--snipeit-token <token>', 'Snipe-IT API token')
  .option('--fleetmanager-dump <path>', 'Path to SnipeScheduler-FleetManager MySQL dump')
  .requiredOption('--out <dir>', 'Output directory for fixture JSON files')
  .option('--dry-run', 'Produce fixtures only; do not import into Panorama', false)
  .option('--page-size <n>', 'Page size for paginated endpoints', (v) => parseInt(v, 10), 100)
  .action(async (opts: MigrateOpts) => {
    try {
      await runMigrate({
        snipeitUrl: opts.snipeitUrl,
        snipeitToken: opts.snipeitToken,
        ...(opts.fleetmanagerDump !== undefined
          ? { fleetmanagerDump: opts.fleetmanagerDump }
          : {}),
        out: opts.out,
        dryRun: opts.dryRun,
        pageSize: opts.pageSize,
      });
    } catch (err) {
      console.error('migrate failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
