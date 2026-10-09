/**
 * Generates THIRD_PARTY_NOTICES.md from pnpm-lock.yaml.
 *
 *   pnpm notices:generate
 *
 * Scope: the PRODUCTION dependency closure of every workspace importer
 * (`dependencies` + `optionalDependencies`, followed transitively through
 * the lockfile snapshots). devDependencies are build/test tooling and are
 * not shipped. Platform-specific optional packages that are not installed
 * on the generating machine are still listed, with their licence read
 * from the npm registry.
 *
 * Licence texts come from each installed package's own LICENSE / NOTICE /
 * COPYING files (including bundler-extracted `*.LICENSE.txt`), deduplicated
 * by identical content. The LGPL section adds the full LGPL-3.0, GPL-3.0
 * and MPL-1.1 (cairo) texts, vendored next to this script, because the
 * prebuilt libvips packages ship without them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const STORE = join(ROOT, 'node_modules', '.pnpm');
const TEXTS = join(__dirname, 'third-party-notices');
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');

interface LockDep {
  version: string;
}
interface Importer {
  dependencies?: Record<string, LockDep>;
  optionalDependencies?: Record<string, LockDep>;
}
interface Snapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface PackageMeta {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface Lockfile {
  importers: Record<string, Importer>;
  packages: Record<string, PackageMeta | null>;
  snapshots: Record<string, Snapshot | null>;
}

interface Pkg {
  name: string;
  version: string;
  license: string;
  source: string;
  installedDir: string | null;
}

/** `name@1.2.3(peer@4)` -> `name@1.2.3` */
function stripPeers(key: string): string {
  const i = key.indexOf('(');
  return i === -1 ? key : key.slice(0, i);
}

function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function prodClosure(lock: Lockfile): string[] {
  const stack: string[] = [];
  for (const importer of Object.values(lock.importers)) {
    for (const deps of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, dep] of Object.entries(deps ?? {})) {
        if (!dep.version.startsWith('link:')) stack.push(`${name}@${dep.version}`);
      }
    }
  }
  const seen = new Set<string>();
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = lock.snapshots[key];
    if (snap === undefined) throw new Error(`lockfile has no snapshot for ${key}`);
    // Resolved peers are recorded as the snapshot's own deps. A required
    // peer is needed at runtime (and auto-installed), so it is followed.
    // An OPTIONAL peer is only used when someone else provides it; following
    // it would pull in e.g. next's `@playwright/test`, which only a
    // devDependency provides.
    const meta = lock.packages[stripPeers(key)]?.peerDependenciesMeta ?? {};
    for (const deps of [snap?.dependencies, snap?.optionalDependencies]) {
      for (const [name, version] of Object.entries(deps ?? {})) {
        if (meta[name]?.optional !== true) stack.push(`${name}@${version}`);
      }
    }
  }
  return [...new Set([...seen].map(stripPeers))].sort();
}

/** The virtual-store dir is `name+scope@version` plus an optional `_peers` suffix. */
function findInstalled(name: string, version: string, storeDirs: string[]): string | null {
  const prefix = `${name.replace('/', '+')}@${version}`;
  for (const dir of storeDirs) {
    if (dir !== prefix && !dir.startsWith(`${prefix}_`)) continue;
    const pkgDir = join(STORE, dir, 'node_modules', name);
    if (existsSync(join(pkgDir, 'package.json'))) return pkgDir;
  }
  return null;
}

function licenseOf(manifest: Record<string, unknown>): string {
  const l = manifest['license'] ?? manifest['licenses'];
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) {
    return l.map((x) => (typeof x === 'string' ? x : String((x as { type?: string }).type))).join(' OR ');
  }
  if (l && typeof l === 'object') return String((l as { type?: string }).type);
  return 'NOASSERTION';
}

function sourceOf(manifest: Record<string, unknown>, name: string): string {
  const repo = manifest['repository'];
  let url = typeof repo === 'string' ? repo : (repo as { url?: string } | undefined)?.url;
  if (!url) url = typeof manifest['homepage'] === 'string' ? (manifest['homepage'] as string) : '';
  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url || `https://www.npmjs.com/package/${name}`;
}

async function registryManifest(name: string, version: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`);
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}@${version}`);
  return (await res.json()) as Record<string, unknown>;
}

const LICENSE_FILE = /(licen[cs]e|copying|notice)/i;

function licenseFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

/** The `License` section of a README, for packages that ship no licence file. */
function readmeLicense(dir: string): { file: string; body: string } | null {
  const readme = readdirSync(dir).find((f) => /^readme(\.|$)/i.test(f));
  if (!readme) return null;
  const text = readFileSync(join(dir, readme), 'utf8');
  const m = /^(#{1,6})\s*licen[cs]e\b.*$/im.exec(text);
  if (!m) return null;
  const level = (m[1] ?? '#').length;
  const rest = text.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body ? { file: `${readme}, License section`, body } : null;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${ticks}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  const lock = parse(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')) as Lockfile;
  const storeDirs = readdirSync(STORE);
  const keys = prodClosure(lock);

  const pkgs: Pkg[] = [];
  for (const key of keys) {
    const { name, version } = splitKey(key);
    const installedDir = findInstalled(name, version, storeDirs);
    const manifest = installedDir
      ? (JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')) as Record<string, unknown>)
      : await registryManifest(name, version);
    pkgs.push({ name, version, license: licenseOf(manifest), source: sourceOf(manifest, name), installedDir });
  }

  const byLicense = new Map<string, number>();
  for (const p of pkgs) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);
  const unknown = pkgs.filter((p) => p.license === 'NOASSERTION');

  // Deduplicate licence texts across packages by exact content.
  const texts = new Map<string, { body: string; owners: string[] }>();
  const noText: Pkg[] = [];
  for (const p of pkgs) {
    if (!p.installedDir) continue;
    const files = licenseFiles(p.installedDir);
    if (files.length === 0) {
      const fromReadme = readmeLicense(p.installedDir);
      if (!fromReadme) {
        noText.push(p);
        continue;
      }
      const hash = createHash('sha256').update(fromReadme.body).digest('hex');
      const entry = texts.get(hash) ?? { body: fromReadme.body, owners: [] };
      entry.owners.push(`${p.name}@${p.version} (${fromReadme.file})`);
      texts.set(hash, entry);
      continue;
    }
    for (const f of files) {
      const body = readFileSync(join(p.installedDir, f), 'utf8');
      const hash = createHash('sha256').update(body.trim()).digest('hex');
      const entry = texts.get(hash) ?? { body, owners: [] };
      entry.owners.push(`${p.name}@${p.version} (${f})`);
      texts.set(hash, entry);
    }
  }

  const lgpl = pkgs.filter((p) => /LGPL/.test(p.license));
  const libvips = lgpl.find((p) => p.name.startsWith('@img/sharp-libvips-') && p.installedDir);
  const notInstalled = pkgs.filter((p) => !p.installedDir);

  const out: string[] = [];
  out.push('# Third-party notices');
  out.push('');
  out.push(
    'Panorama is licensed under AGPL-3.0-or-later (see `LICENSE`). It depends on',
    'third-party packages that keep their own licences. This file lists every',
    'package in the **production** dependency closure of the workspace, as',
    'resolved in `pnpm-lock.yaml`, and reproduces their licence and notice texts.',
    'Development-only tooling (test runners, linters, the documentation site) is',
    'not distributed and is not listed.',
  );
  out.push('');
  out.push('Generated by `pnpm notices:generate` (`scripts/third-party-notices.ts`). Do not edit by hand.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`${pkgs.length} packages (name@version), by declared licence:`);
  out.push('');
  out.push('| Licence | Packages |');
  out.push('|---|---:|');
  for (const [l, n] of [...byLicense].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push(`| ${cell(l)} | ${n} |`);
  }
  out.push('');
  if (notInstalled.length > 0) {
    out.push(
      `${notInstalled.length} of these are platform-specific optional packages (other operating`,
      'systems or CPU architectures); their licence is read from the npm registry.',
      'Each one ships the same upstream code as the variant listed with its texts below.',
    );
    out.push('');
  }

  out.push('## LGPL-3.0-or-later: libvips (via `sharp`)');
  out.push('');
  out.push(
    'Image processing uses `sharp`, which loads prebuilt **libvips** shared libraries',
    'from the packages below. They are licensed LGPL-3.0-or-later and are dynamically',
    'linked: the `.so` / `.dylib` / `.dll` files can be replaced with a modified build',
    'of the same version.',
  );
  out.push('');
  for (const p of lgpl) out.push(`- \`${p.name}@${p.version}\` (${p.license})`);
  out.push('');
  if (libvips?.installedDir) {
    const versionsPath = join(libvips.installedDir, 'versions.json');
    const versions = existsSync(versionsPath)
      ? (JSON.parse(readFileSync(versionsPath, 'utf8')) as Record<string, string>)
      : {};
    out.push('**Corresponding source.**');
    out.push('');
    if (versions['vips']) {
      out.push(`- libvips ${versions['vips']}: https://github.com/libvips/libvips/tree/v${versions['vips']}`);
    }
    out.push(
      `- Build scripts and patches for the bundled libraries (package version ${libvips.version}): https://github.com/lovell/sharp-libvips/tree/v${libvips.version}`,
    );
    out.push('');
    const readme = readFileSync(join(libvips.installedDir, 'README.md'), 'utf8');
    const licensing = /## Licensing\n([\s\S]*?)(?=\n## |$)/.exec(readme)?.[1]?.trim();
    if (licensing) {
      out.push(`**Libraries bundled in the binaries** (from \`${libvips.name}\` README):`);
      out.push('');
      out.push(licensing);
      out.push('');
      if (/Mozilla Public License 1\.1/.test(licensing) && versions['cairo']) {
        out.push(
          `cairo is used under the Mozilla Public License 1.1 (text below). Source for cairo ${versions['cairo']}: ` +
            `https://gitlab.freedesktop.org/cairo/cairo/-/tree/${versions['cairo']}`,
        );
        out.push('');
      }
    }
    if (Object.keys(versions).length > 0) {
      out.push('**Bundled library versions** (`versions.json`):');
      out.push('');
      out.push(fence(JSON.stringify(versions, null, 2)));
      out.push('');
    }
  }
  out.push('### GNU Lesser General Public License v3.0');
  out.push('');
  out.push(fence(readFileSync(join(TEXTS, 'LGPL-3.0.txt'), 'utf8')));
  out.push('');
  out.push('### GNU General Public License v3.0 (incorporated by the LGPL)');
  out.push('');
  out.push(fence(readFileSync(join(TEXTS, 'GPL-3.0.txt'), 'utf8')));
  out.push('');
  out.push('### Mozilla Public License 1.1 (cairo, bundled in the libvips binaries)');
  out.push('');
  out.push(fence(readFileSync(join(TEXTS, 'MPL-1.1.txt'), 'utf8')));
  out.push('');

  out.push('## Package inventory');
  out.push('');
  out.push('| Package | Version | Licence | Source |');
  out.push('|---|---|---|---|');
  for (const p of pkgs) {
    out.push(`| \`${p.name}\` | ${p.version} | ${cell(p.license)} | ${p.source} |`);
  }
  out.push('');

  out.push('## Licence and notice texts');
  out.push('');
  out.push(
    'Reproduced from each package. Identical texts are shown once, followed by every',
    'package that ships them.',
  );
  out.push('');
  const sorted = [...texts.values()].sort((a, b) => (a.owners[0] ?? '').localeCompare(b.owners[0] ?? ''));
  for (const t of sorted) {
    out.push(`### ${t.owners[0]}${t.owners.length > 1 ? ` and ${t.owners.length - 1} more` : ''}`);
    out.push('');
    if (t.owners.length > 1) {
      out.push(`Shipped by: ${t.owners.map((o) => `\`${o}\``).join(', ')}`);
      out.push('');
    }
    out.push(fence(t.body));
    out.push('');
  }
  if (noText.length > 0) {
    out.push('### Packages that ship no licence file');
    out.push('');
    out.push('Their declared licence is in the inventory above.');
    out.push('');
    for (const p of noText) out.push(`- \`${p.name}@${p.version}\` (${p.license}): ${p.source}`);
    out.push('');
  }

  writeFileSync(OUT, `${out.join('\n').trimEnd()}\n`);
  console.log(
    `THIRD_PARTY_NOTICES.md: ${pkgs.length} packages, ${byLicense.size} licences, ` +
      `${texts.size} distinct texts, ${noText.length} without a licence file, ` +
      `${notInstalled.length} from the registry, ${unknown.length} without a declared licence`,
  );
  for (const p of unknown) console.log(`  no declared licence: ${p.name}@${p.version}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
