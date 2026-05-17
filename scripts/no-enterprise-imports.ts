/**
 * no-enterprise-imports — static gate for ADR-0002 (oss/commercial split).
 *
 * Round 5 PR1 (#49) rename + scope-expansion of the prior
 * `ensure-community-complete` script. The old name claimed a
 * functional-completeness assertion the script could not actually
 * deliver — see `docs/en/feature-matrix.md` §"What Community will
 * never hold back" for what *does* assert that today. This script
 * is now honestly named: it rejects any reference to enterprise
 * package names anywhere in the community repo.
 *
 * Lineage:
 *   - Original: `grep -R "panorama-enterprise" apps/ packages/ ... && exit 1 || exit 0`
 *     (Wave 0; masked grep exit 2; missed scoped names; no error handling).
 *   - Wave 2d.D / #69: replaced grep with a TS script using two regex
 *     shapes + structured exit codes + allowlist.
 *   - Round 5 PR1 / #49 (this revision):
 *       * renamed `ensure:community-complete` → `check:no-enterprise-imports`
 *       * scan extensions extended from {.ts, .tsx, .json} to also cover
 *         .js, .mjs, .cjs, .yml, .yaml — every config + build surface
 *         that could pull an enterprise package by name
 *       * scan locations extended from {apps/, packages/} to also cover
 *         the repo-root package.json + pnpm-lock.yaml + .github/ tree —
 *         where a `pnpm.overrides` redirect or a workflow `pnpm add`
 *         would otherwise slip past
 *       * functional gate (the "e2e suite runs without enterprise code"
 *         claim previously misattributed to this script) is now
 *         apps/core-api/test/community-smoke.e2e.test.ts
 *
 * Why no runtime require-cache guard:
 *   There are zero `@panorama/enterprise-*` packages in the repo today
 *   (the private repo is gated on day-60 metrics per ADR-0002), so a
 *   boot-time scan of `require.cache` for enterprise module paths has
 *   nothing to find. When the enterprise repo first lands, add the
 *   runtime guard at the same PR — that's the right time, when there
 *   are concrete test cases to exercise it. Until then, the static
 *   regex below + the e2e suite are the load-bearing gates.
 *
 * Exit codes:
 *   0 — clean
 *   1 — violations (file:line list printed; CI fails)
 *   2 — scan error (unreadable file, etc.); CI fails for investigation
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url);

// File trees scanned recursively. Add new top-level dirs here when
// the repo grows new code locations.
const SCAN_DIRS = ['apps', 'packages', '.github'];

// Repo-root files scanned individually (no recursion needed). The
// pnpm.overrides block + the lockfile are the two slip-through
// vectors not covered by the dir walks above.
const SCAN_ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
]);

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
// (e.g., this script's regex strings). Listed as repo-relative POSIX
// paths; matched as exact suffixes.
const ALLOWLIST_FILES: string[] = [
  'scripts/no-enterprise-imports.ts',
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

async function scanFile(
  path: string,
  allowlist: Set<string>,
  out: Violation[],
): Promise<void> {
  const repoRelPath = path.replace(/\\/g, '/');
  if ([...allowlist].some((suffix) => repoRelPath.endsWith(suffix))) return;

  let body: string;
  try {
    body = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
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

    await scanFile(join(dir, entry.name), allowlist, out);
  }
}

async function main(): Promise<void> {
  const repoRoot = ROOT.pathname.replace(/\/$/, '');
  const allowlist = new Set(ALLOWLIST_FILES);
  const violations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    await walkDirectory(join(repoRoot, dir), allowlist, violations);
  }
  for (const file of SCAN_ROOT_FILES) {
    await scanFile(join(repoRoot, file), allowlist, violations);
  }

  if (violations.length > 0) {
    console.error('No-enterprise-imports violations:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — matched "${v.match}" (${v.pattern})`);
    }
    console.error(
      `\n${violations.length} violation${violations.length === 1 ? '' : 's'}. ` +
        'Enterprise package references must not land in the community repo. ' +
        'See ADR-0002 (oss/commercial split).',
    );
    process.exit(1);
  }
  console.log(
    `No-enterprise-imports OK — scanned ${SCAN_DIRS.join(', ')} (+ ${SCAN_ROOT_FILES.join(', ')}) ` +
      'across .ts/.tsx/.js/.mjs/.cjs/.json/.yml/.yaml; no enterprise references found.',
  );
}

main().catch((err) => {
  console.error('no-enterprise-imports failed unexpectedly:', err);
  process.exit(2);
});
