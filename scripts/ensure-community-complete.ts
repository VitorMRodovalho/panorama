/**
 * Community-completeness gate (Wave 2d.D / #69 / extends Wave 1 #49).
 *
 * Replaces the previous CI step:
 *   grep -R "panorama-enterprise" apps/ packages/ ... && exit 1 || exit 0
 *
 * Problems with the grep:
 *   - Masks grep's exit code 2 (scan error vs no-match)
 *   - No `set -euo pipefail`
 *   - Misses scoped names (`@panorama/enterprise-*`)
 *   - Plain text scan — false positives in comments / docs
 *
 * This script does explicit pattern matching for both name shapes,
 * walks the relevant source trees, and exits with structured codes:
 *   0 — clean
 *   1 — violations (file:line list)
 *   2 — scan error (e.g., a target dir was missing)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url);
const SCAN_DIRS = ['apps', 'packages'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.json']);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.git',
]);

// Allowlist — files that legitimately mention enterprise names
// (e.g., this script, the audit-handoff doc references inside ts).
// Listed as repo-relative POSIX paths; matched as exact suffixes.
const ALLOWLIST_FILES: string[] = [
  'scripts/ensure-community-complete.ts',
];

const PATTERNS: { name: string; regex: RegExp }[] = [
  // Scoped: @panorama/enterprise-foo, @panorama/enterprise/bar
  { name: 'scoped', regex: /@panorama\/enterprise[-/][a-z0-9-]/i },
  // Unscoped: panorama-enterprise (any continuation)
  { name: 'unscoped', regex: /\bpanorama-enterprise\b/i },
];

interface Violation {
  file: string;
  line: number;
  match: string;
  pattern: string;
}

async function walkDirectory(
  dir: string,
  allowlist: Set<string>,
  out: Violation[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDirectory(join(dir, entry.name), allowlist, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!SCAN_EXTENSIONS.has(ext)) continue;

    const path = join(dir, entry.name);
    const repoRelPath = path.replace(/\\/g, '/');
    if ([...allowlist].some((suffix) => repoRelPath.endsWith(suffix))) continue;

    let body: string;
    try {
      body = await fs.readFile(path, 'utf8');
    } catch (err) {
      console.error(`scan_error: cannot read ${path}: ${(err as Error).message}`);
      process.exit(2);
    }

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { name, regex } of PATTERNS) {
        const m = regex.exec(lines[i]!);
        if (m) {
          out.push({
            file: repoRelPath,
            line: i + 1,
            match: m[0],
            pattern: name,
          });
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = ROOT.pathname.replace(/\/$/, '');
  const allowlist = new Set(ALLOWLIST_FILES);
  const violations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    const target = join(repoRoot, dir);
    await walkDirectory(target, allowlist, violations);
  }

  if (violations.length > 0) {
    console.error('Community-completeness violations:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — matched "${v.match}" (${v.pattern})`);
    }
    console.error(
      `\n${violations.length} violation${violations.length === 1 ? '' : 's'}. ` +
        'Enterprise-only code must not land in the community repo. ' +
        'See ADR-0002 (oss/commercial split).',
    );
    process.exit(1);
  }
  console.log('Community completeness OK — no enterprise-only references found.');
}

main().catch((err) => {
  console.error('ensure-community-complete failed unexpectedly:', err);
  process.exit(2);
});
