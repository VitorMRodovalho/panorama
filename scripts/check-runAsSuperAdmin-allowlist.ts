/**
 * RLS-CI allowlist gate (Wave 2 RLS-CI / #58).
 *
 * Counts `prisma.runAsSuperAdmin(` invocations per source file under
 * `apps/core-api/src` and compares against the budget defined in
 * `.runAsSuperAdmin.allowlist.json` at the repo root. Fails CI if:
 *
 *   - A file's actual count exceeds its allowlist budget (drift)
 *   - A new file appears with non-zero count and is not in the allowlist
 *
 * Also flags (warning, not failing) when a file's actual count is BELOW
 * its budget — that's an opportunity to lower the budget, encouraging
 * the ratchet-down direction.
 *
 * Detection is regex-based on `\.runAsSuperAdmin\s*\(` against TS source.
 * Comments and JSDoc references are filtered out by skipping lines that
 * start with `*` or `//`.
 *
 * Exit codes:
 *   0 — allowlist matches reality
 *   1 — drift detected (PR must adjust the allowlist with reviewer
 *       sign-off, OR migrate the new call to runInTenant)
 *   2 — scan error
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url);
const SCAN_DIR = 'apps/core-api/src';
const ALLOWLIST_PATH = '.runAsSuperAdmin.allowlist.json';
const CALL_REGEX = /\.runAsSuperAdmin\s*\(/;

interface AllowlistEntry {
  budget: number;
  rationale: string;
}

interface Allowlist {
  files: Record<string, AllowlistEntry>;
}

async function walkDirectory(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await walkDirectory(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    out.push(join(dir, entry.name));
  }
}

async function countCallsInFile(path: string): Promise<number> {
  const body = await fs.readFile(path, 'utf8');
  let count = 0;
  for (const raw of body.split('\n')) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (CALL_REGEX.test(raw)) count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const repoRoot = ROOT.pathname.replace(/\/$/, '');
  const allowlistRaw = await fs.readFile(join(repoRoot, ALLOWLIST_PATH), 'utf8');
  const allowlist = JSON.parse(allowlistRaw) as Allowlist;

  const files: string[] = [];
  await walkDirectory(join(repoRoot, SCAN_DIR), files);

  const actual = new Map<string, number>();
  for (const path of files) {
    const count = await countCallsInFile(path);
    if (count > 0) {
      const repoRel = path.slice(repoRoot.length + 1);
      actual.set(repoRel, count);
    }
  }

  const violations: string[] = [];
  const warnings: string[] = [];

  for (const [file, count] of actual) {
    const entry = allowlist.files[file];
    if (!entry) {
      violations.push(
        `  ${file}: ${count} unallowlisted call(s). ` +
          `Either migrate to runInTenant or add an entry to .runAsSuperAdmin.allowlist.json with reviewer sign-off.`,
      );
      continue;
    }
    if (count > entry.budget) {
      violations.push(
        `  ${file}: ${count} calls (budget ${entry.budget}). ` +
          `Drift requires either migrating new sites to runInTenant or raising the budget with security-reviewer approval.`,
      );
    } else if (count < entry.budget) {
      warnings.push(
        `  ${file}: ${count} calls (budget ${entry.budget}). ` +
          `A site migrated; lower the budget in the allowlist to lock in the ratchet.`,
      );
    }
  }

  for (const file of Object.keys(allowlist.files)) {
    if (!actual.has(file)) {
      warnings.push(
        `  ${file}: allowlist entry but zero calls in source. Remove the entry.`,
      );
    }
  }

  if (warnings.length > 0) {
    console.log('runAsSuperAdmin allowlist — ratchet opportunities:');
    for (const w of warnings) console.log(w);
    console.log();
  }

  if (violations.length > 0) {
    console.error('runAsSuperAdmin allowlist VIOLATIONS:');
    for (const v of violations) console.error(v);
    console.error(
      `\n${violations.length} violation${violations.length === 1 ? '' : 's'}. ` +
        'See ADR-0015 + .runAsSuperAdmin.allowlist.json for the policy.',
    );
    process.exit(1);
  }

  const total = [...actual.values()].reduce((a, b) => a + b, 0);
  console.log(
    `runAsSuperAdmin allowlist OK — ${total} calls across ${actual.size} files.`,
  );
}

main().catch((err) => {
  console.error('check-runAsSuperAdmin-allowlist failed unexpectedly:', err);
  process.exit(2);
});
