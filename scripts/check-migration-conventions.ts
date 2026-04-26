/**
 * Migration convention gate (Wave 2d.F / #71 / closes Wave 1 ARCH-11).
 *
 * Every Prisma migration folder under apps/core-api/prisma/migrations
 * must contain:
 *
 *   1. migration.sql       — what Prisma executes
 *   2. ROLLBACK.md (≥40 chars) — reversibility note per CONTRIBUTING #4
 *   3. EXACTLY ONE of:
 *        rls.sql              — applied by the CI's RLS apply loop
 *        NO_RLS.md (≥80 chars) — explicit skip with reviewer rationale
 *
 * The script exits non-zero on any violation so CI fails fast. It
 * also rejects folders that contain BOTH rls.sql and NO_RLS.md
 * (ambiguity defeats the gate).
 *
 * Symlinks under migrations/ are followed; non-directory entries
 * other than `migration_lock.toml` and `README.md` are flagged.
 */

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';

const MIGRATIONS_DIR = new URL(
  '../apps/core-api/prisma/migrations/',
  import.meta.url,
);

const ROLLBACK_MIN_CHARS = 40;
const NO_RLS_MIN_CHARS = 80;
const ALLOWED_TOP_LEVEL_FILES = new Set(['migration_lock.toml', 'README.md']);
const REQUIRED_FILE = 'migration.sql';
const ROLLBACK_FILE = 'ROLLBACK.md';
const RLS_FILE = 'rls.sql';
const NO_RLS_FILE = 'NO_RLS.md';

interface Violation {
  folder: string;
  message: string;
}

async function statSize(path: string): Promise<number | null> {
  try {
    const s = await fs.stat(path);
    return s.size;
  } catch {
    return null;
  }
}

async function checkFolder(folderUrl: URL, name: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const folderPath = folderUrl.pathname;

  const migrationSql = join(folderPath, REQUIRED_FILE);
  if ((await statSize(migrationSql)) === null) {
    violations.push({ folder: name, message: `missing ${REQUIRED_FILE}` });
  }

  const rollbackPath = join(folderPath, ROLLBACK_FILE);
  const rollbackSize = await statSize(rollbackPath);
  if (rollbackSize === null) {
    violations.push({ folder: name, message: `missing ${ROLLBACK_FILE}` });
  } else if (rollbackSize < ROLLBACK_MIN_CHARS) {
    violations.push({
      folder: name,
      message: `${ROLLBACK_FILE} is too short (${rollbackSize} chars, need ≥${ROLLBACK_MIN_CHARS}). Describe revert SQL + when to use it.`,
    });
  }

  const rlsPath = join(folderPath, RLS_FILE);
  const noRlsPath = join(folderPath, NO_RLS_FILE);
  const rlsSize = await statSize(rlsPath);
  const noRlsSize = await statSize(noRlsPath);
  const hasRls = rlsSize !== null;
  const hasNoRls = noRlsSize !== null;

  if (hasRls && hasNoRls) {
    violations.push({
      folder: name,
      message: `cannot have BOTH ${RLS_FILE} and ${NO_RLS_FILE}. Pick one — the migration either touches RLS or it does not.`,
    });
  } else if (!hasRls && !hasNoRls) {
    violations.push({
      folder: name,
      message: `missing one of ${RLS_FILE} or ${NO_RLS_FILE}. If the migration intentionally has no RLS surface, add ${NO_RLS_FILE} (≥${NO_RLS_MIN_CHARS} chars rationale).`,
    });
  } else if (hasNoRls && noRlsSize! < NO_RLS_MIN_CHARS) {
    violations.push({
      folder: name,
      message: `${NO_RLS_FILE} is too short (${noRlsSize} chars, need ≥${NO_RLS_MIN_CHARS}). Skip rationale must include reviewer name + review date + re-evaluation criteria.`,
    });
  }

  return violations;
}

async function main(): Promise<void> {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const violations: Violation[] = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      if (!ALLOWED_TOP_LEVEL_FILES.has(entry.name)) {
        violations.push({
          folder: '<root>',
          message: `unexpected top-level file: ${entry.name}. Allowed: ${[...ALLOWED_TOP_LEVEL_FILES].join(', ')}.`,
        });
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const folderUrl = new URL(`${entry.name}/`, MIGRATIONS_DIR);
    const found = await checkFolder(folderUrl, entry.name);
    violations.push(...found);
  }

  if (violations.length > 0) {
    console.error('Migration convention violations:');
    for (const v of violations) {
      console.error(`  ${v.folder}: ${v.message}`);
    }
    console.error(
      `\n${violations.length} violation${violations.length === 1 ? '' : 's'}. ` +
        'See CONTRIBUTING.md "Migrations must be reversible" + the audit Wave 2d.F write-up.',
    );
    process.exit(1);
  }
  console.log(`Migration conventions OK (${entries.length} entries scanned).`);
}

main().catch((err) => {
  console.error('Migration convention check failed unexpectedly:', err);
  process.exit(2);
});
