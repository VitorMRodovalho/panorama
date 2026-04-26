#!/usr/bin/env node
/**
 * panorama-tenant-nominate-owner CLI (ADR-0007 rule 7).
 *
 * Super-admin break-glass command. Idempotently installs the named
 * user as an `owner` membership on the named tenant, writing a
 * `panorama.tenant.ownership_restored` audit event with the operator
 * identity and a required reason string. Tenant admins see the audit
 * event post-facto — this path is never hidden from them.
 *
 * Usage:
 *   pnpm --filter @panorama/core-api exec tsx \
 *     src/scripts/tenant-nominate-owner.ts \
 *     --tenant acme \
 *     --email alice@acme.example \
 *     --operator operator@panorama.example \
 *     --reason "customer support ticket #12345: last owner left company"
 *
 * The user being nominated MUST already exist in the `users` table.
 * If you need to create the user too, run the user-seed script first
 * — the ADR keeps those concerns separate so this command stays
 * small and auditable.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { TenantAdminService } from '../modules/tenant/tenant-admin.service.js';

interface CliArgs {
  tenant: string;
  email: string;
  reason: string;
  operator: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[++i];
    if (a === '--tenant' && next !== undefined) args.tenant = next;
    else if (a === '--email' && next !== undefined) args.email = next;
    else if (a === '--reason' && next !== undefined) args.reason = next;
    else if (a === '--operator' && next !== undefined) args.operator = next;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      // rewind — the flag didn't consume a value
      i--;
    }
  }
  const missing: string[] = [];
  if (!args.tenant) missing.push('--tenant');
  if (!args.email) missing.push('--email');
  if (!args.reason) missing.push('--reason');
  if (!args.operator) missing.push('--operator');
  if (missing.length > 0) {
    console.error(`Missing required flags: ${missing.join(', ')}`);
    printUsage();
    process.exit(1);
  }
  return args as CliArgs;
}

function printUsage(): void {
  console.log(
    `Usage:\n` +
      `  panorama tenant-nominate-owner\n` +
      `    --tenant <slug>\n` +
      `    --email <email>\n` +
      `    --operator <operator-email>\n` +
      `    --reason "<short human reason>"\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const log = new Logger('tenant-nominate-owner');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const svc = app.get(TenantAdminService, { strict: false });
    const result = await svc.nominateOwner({
      tenantSlug: args.tenant,
      email: args.email,
      reason: args.reason,
      operatorEmail: args.operator,
    });
    log.log(
      {
        tenantSlug: args.tenant,
        email: args.email,
        operator: args.operator,
        membershipId: result.membership.id,
        created: result.created,
      },
      result.created
        ? 'owner_membership_created'
        : 'owner_membership_reactivated',
    );
    process.exitCode = 0;
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
   
  console.error('tenant-nominate-owner failed:', err);
  process.exit(1);
});
