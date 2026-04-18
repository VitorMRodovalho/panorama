#!/usr/bin/env node
/**
 * panorama-import-fixtures CLI.
 *
 * Standalone Nest application context (no HTTP server) that wires the
 * ImportService via DI and runs it against a fixtures directory. Use
 * this from ops for a one-shot migration; wire into a background job
 * queue in 0.3 for larger tenants.
 *
 * Usage:
 *   pnpm --filter @panorama/core-api exec tsx src/scripts/import-fixtures.ts \
 *     --dir ./migrated --dry-run
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { ImportModule } from '../modules/import/import.module.js';
import { ImportService } from '../modules/import/import.service.js';

interface CliArgs {
  dir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = { dir: '', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: panorama-import-fixtures --dir <path> [--dry-run]`);
      process.exit(0);
    }
  }
  if (!args.dir) {
    console.error('Missing --dir');
    process.exit(1);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const log = new Logger('import-fixtures');

  // createApplicationContext = no HTTP server, just the DI container.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    // Resolve the service through the ImportModule chain
    void ImportModule; // side-effect import ensures bundling keeps it
    const svc = app.get(ImportService, { strict: false });
    const result = await svc.run({ dir: args.dir, dryRun: args.dryRun });

    log.log({ result }, 'import_complete');
    const exitCode = result.errors.length > 0 ? 1 : 0;
    process.exitCode = exitCode;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('import-fixtures failed:', err);
  process.exit(1);
});
