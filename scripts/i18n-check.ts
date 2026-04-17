/**
 * i18n coverage gate.
 * Every key present in packages/i18n/en/*.json MUST exist in pt-br/ and es/.
 * A missing key fails CI and blocks the PR.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../packages/i18n/', import.meta.url);
const LOCALES = ['en', 'pt-br', 'es'];
const REFERENCE = 'en';

type Bundle = Record<string, string>;

async function loadLocale(locale: string): Promise<Map<string, Bundle>> {
  const dir = new URL(`${locale}/`, ROOT);
  const files = await fs.readdir(dir);
  const bundles = new Map<string, Bundle>();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const body = await fs.readFile(new URL(file, dir), 'utf8');
    bundles.set(file, JSON.parse(body) as Bundle);
  }
  return bundles;
}

async function main(): Promise<void> {
  const loaded = new Map<string, Map<string, Bundle>>();
  for (const loc of LOCALES) loaded.set(loc, await loadLocale(loc));

  const reference = loaded.get(REFERENCE);
  if (!reference) throw new Error(`Missing reference locale "${REFERENCE}"`);

  const problems: string[] = [];

  for (const [file, refBundle] of reference) {
    for (const loc of LOCALES) {
      if (loc === REFERENCE) continue;
      const bundles = loaded.get(loc);
      const other = bundles?.get(file);
      if (!other) {
        problems.push(`[${loc}] missing file: ${file}`);
        continue;
      }
      for (const key of Object.keys(refBundle)) {
        if (!(key in other)) {
          problems.push(`[${loc}] ${file} missing key: ${key}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error('i18n coverage check failed:\n' + problems.map((p) => '  - ' + p).join('\n'));
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('i18n coverage OK — EN/PT-BR/ES in sync across ' + LOCALES.length + ' locales.');
}

await main();
