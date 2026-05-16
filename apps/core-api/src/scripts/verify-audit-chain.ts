#!/usr/bin/env tsx
/**
 * verify-audit-chain — per-row hash integrity check for audit_events.
 *
 * Usage:
 *
 *   pnpm --filter @panorama/core-api chain-verify
 *   pnpm --filter @panorama/core-api chain-verify --json
 *
 * Connects via `DATABASE_PRIVILEGED_URL` (per ADR-0015 v2 the only
 * role with cross-tenant read capacity via BYPASSRLS — declared
 * directly on the role attribute on self-hosted, gated by the
 * SECURITY DEFINER `panorama_enable_bypass_rls()` function on managed
 * Postgres). Walks every audit row in id order and asserts:
 *
 *   sha256(COALESCE(prevHash, '') || digestPreImage) == selfHash
 *
 * Rows where `digestPreImage IS NULL` (pre-migration-0021 legacy
 * rows; post-rollback gap rows) cannot be byte-exact verified from
 * columns alone and are recorded as "legacy (unverifiable)".
 *
 * **Scope** — this CLI verifies per-row tamper integrity only. The
 * audit chain is intentionally multi-strand under the SECURITY
 * DEFINER trigger + `runInTenant` RLS contracts (see
 * `audit.service.ts` docstring): prev_hash links cross tenant
 * strands by design, so a single-pass prev_link walk would report
 * false mismatches on cross-tenant adjacency. Per-row reproducibility
 * IS the trust anchor SECURITY.md promises; multi-strand prev-link
 * verification at audit-time is a separate workstream.
 *
 * Exit code:
 *
 *   0 — every non-legacy row's selfHash matches its recomputed digest
 *   1 — at least one row's selfHash does not match its recomputed
 *       digest (tamper signal)
 *   2 — operational error (no DATABASE_PRIVILEGED_URL, query failure,
 *       empty result when a cutover marker was expected, etc.)
 */

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

interface AuditRow {
  id: bigint;
  tenantId: string | null;
  action: string;
  prevHash: Buffer | null;
  selfHash: Buffer;
  digestPreImage: Buffer | null;
}

interface RowFinding {
  id: string;
  tenantId: string | null;
  action: string;
  detail: string;
}

interface Report {
  generatedAt: string;
  totalRows: number;
  verified: number;
  legacy: number;
  digestMismatches: number;
  firstMismatch: RowFinding | null;
  ok: boolean;
}

function asBuffer(b: Buffer | null | undefined): Buffer | null {
  if (b == null) return null;
  // Prisma 6 returns Bytes as Uint8Array on some drivers; Buffer is a
  // Uint8Array subclass so structural copy normalises both shapes.
  return Buffer.isBuffer(b) ? b : Buffer.from(b);
}

function verifyRow(row: AuditRow): { kind: 'ok' | 'legacy' | 'mismatch'; detail?: string } {
  const preImage = asBuffer(row.digestPreImage);
  if (preImage === null) {
    return { kind: 'legacy' };
  }
  const prevHash = asBuffer(row.prevHash);
  const selfHash = asBuffer(row.selfHash)!;
  const h = createHash('sha256');
  if (prevHash) h.update(prevHash);
  h.update(preImage);
  const recomputed = h.digest();
  if (Buffer.compare(recomputed, selfHash) !== 0) {
    return {
      kind: 'mismatch',
      detail: `selfHash = ${selfHash.toString('hex')}, recomputed = ${recomputed.toString('hex')}`,
    };
  }
  return { kind: 'ok' };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_PRIVILEGED_URL;
  if (!url) {
    process.stderr.write(
      'verify-audit-chain: DATABASE_PRIVILEGED_URL is not set. ' +
        'See docs/runbooks/secrets-inventory.md §Postgres for the value. ' +
        'Aborting.\n',
    );
    return 2;
  }

  const json = process.argv.includes('--json');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // CRITICAL: `panorama_enable_bypass_rls()` sets a tx-local GUC
    // via `set_config(..., true)`. Outside an explicit $transaction,
    // each statement runs in its own autocommit tx and the GUC dies
    // immediately. On managed Postgres where `panorama_super_admin`
    // is NOBYPASSRLS (ADR-0015 v2), this would silently return zero
    // rows and report PASS over an empty set. Wrap both calls in
    // the SAME tx so the bypass stays in scope for the read.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT panorama_enable_bypass_rls()');
      return tx.auditEvent.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          tenantId: true,
          action: true,
          prevHash: true,
          selfHash: true,
          digestPreImage: true,
        },
      });
    });
    const rows = result as unknown as AuditRow[];

    const report: Report = {
      generatedAt: new Date().toISOString(),
      totalRows: rows.length,
      verified: 0,
      legacy: 0,
      digestMismatches: 0,
      firstMismatch: null,
      ok: false,
    };
    for (const row of rows) {
      const v = verifyRow(row);
      if (v.kind === 'ok') {
        report.verified++;
      } else if (v.kind === 'legacy') {
        report.legacy++;
      } else {
        report.digestMismatches++;
        report.firstMismatch ??= {
          id: row.id.toString(),
          tenantId: row.tenantId,
          action: row.action,
          detail: v.detail ?? '',
        };
      }
    }
    report.ok = report.digestMismatches === 0 && rows.length > 0;

    if (rows.length === 0) {
      // Empty audit_events is suspect — every prior migration emits
      // at least a chain-repair cutover marker (0015 / 0020 / 0021).
      // If the verifier sees zero rows on a real DB, either (a) the
      // BYPASSRLS path silently filtered everything (the bug this
      // CLI's $transaction wrap guards against), or (b) someone
      // truncated audit_events (which is itself a chain-integrity
      // failure). Either way: do not report PASS over an empty set.
      process.stderr.write(
        'verify-audit-chain: audit_events is empty — cannot distinguish ' +
          '"fresh DB with no migrations" from "RLS-filtered to zero rows" ' +
          'from "table was truncated". Treat as op-error; investigate.\n',
      );
      report.ok = false;
      if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        writeHumanReport(report);
      }
      return 2;
    }

    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      writeHumanReport(report);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `verify-audit-chain: operational error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

function writeHumanReport(report: Report): void {
  // Three-way status so an on-call eye distinguishes "tamper, page"
  // from "empty / op-error, investigate." The empty-rows path is the
  // belt-and-braces for the BYPASS-GUC scope bug — if a future
  // regression silently filters everything to zero, the operator
  // sees OP-ERROR (not a misleading FAIL that looks like a tamper).
  const status = report.totalRows === 0
    ? 'OP-ERROR (empty result)'
    : report.ok ? 'PASS' : 'FAIL';
  const out = process.stdout;
  out.write(`audit chain verification — ${status}\n`);
  out.write(`generated:               ${report.generatedAt}\n`);
  out.write(`total rows:              ${report.totalRows}\n`);
  out.write(`verified:                ${report.verified}\n`);
  out.write(`legacy (pre-0021, NULL): ${report.legacy}\n`);
  out.write(`digest mismatches:       ${report.digestMismatches}\n`);
  if (report.firstMismatch) {
    out.write(`\nfirst mismatch:\n`);
    out.write(`  id:       ${report.firstMismatch.id}\n`);
    out.write(`  tenantId: ${report.firstMismatch.tenantId ?? '<null>'}\n`);
    out.write(`  action:   ${report.firstMismatch.action}\n`);
    out.write(`  detail:   ${report.firstMismatch.detail}\n`);
  }
}

void main().then((code) => {
  process.exit(code);
});
