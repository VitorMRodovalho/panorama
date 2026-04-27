/**
 * i18n JSX gate.
 *
 * Walks `apps/web/src/**\/*.tsx` and fails if any JSXText node contains
 * two or more letter-word tokens that aren't in the allowlist. The goal
 * is to lock in trilingual hygiene after the #44 effort: future PRs
 * that reintroduce hardcoded English JSX text trip CI.
 *
 * Heuristic limitations:
 * - Only flags `JSXText` nodes. Hardcoded `placeholder="..."`,
 *   `title="..."`, or `{'string literal'}` inside JSX still pass.
 *   Those have a much lower regression rate in this codebase (the
 *   established pattern routes them through `messages.t(...)` already),
 *   and widening the rule introduces more false positives than it
 *   catches.
 * - Allowlist is exact-match. Add entries with intent — every line
 *   weakens the gate.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const ROOT = new URL('../', import.meta.url);
const SCAN_DIR = new URL('apps/web/src/', ROOT);

// Phrases the heuristic flags but should not block CI. Each entry is
// the trimmed JSXText. Whitespace and JSX entity references (`&nbsp;`)
// are stripped before comparison.
const ALLOWLIST = new Set<string>([
  // Visual separators / fixed glyphs
  '—',
  '→',
  '←',
  '...',
  '…',
]);

// JSX elements whose text content is intentionally literal (code
// snippets, keyboard shortcuts, sample IDs). Skipped wholesale.
const LITERAL_PARENT_ELEMENTS = new Set<string>(['code', 'pre', 'kbd', 'samp']);

interface Violation {
  file: string;
  line: number;
  text: string;
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = new URL(
      entry.name + (entry.isDirectory() ? '/' : ''),
      dir,
    );
    if (entry.isDirectory()) {
      yield* walk(child);
    } else if (entry.name.endsWith('.tsx')) {
      yield child;
    }
  }
}

function countWords(text: string): number {
  // A "word" is a run of 2+ letters. Single-letter tokens like "a" or
  // "I" don't count toward the threshold so we don't trip on
  // separators like " - " or ":" embedded in expression-heavy JSX.
  const words = text.match(/[A-Za-zÀ-ÿ]{2,}/g) ?? [];
  return words.length;
}

function isInsideLiteralParent(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const tagName = cur.openingElement.tagName;
      if (ts.isIdentifier(tagName) && LITERAL_PARENT_ELEMENTS.has(tagName.text)) {
        return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

async function check(filePath: URL): Promise<Violation[]> {
  const sourceText = await fs.readFile(filePath, 'utf8');
  const path = fileURLToPath(filePath);
  const sf = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const violations: Violation[] = [];
  const rootPath = fileURLToPath(ROOT);

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const raw = node.getText();
      // Collapse whitespace + entity refs so multi-line JSXText with
      // mostly whitespace gets evaluated on its actual word content.
      const trimmed = raw.replace(/&nbsp;/g, ' ').trim();
      if (trimmed.length === 0) return;
      if (ALLOWLIST.has(trimmed)) return;
      if (isInsideLiteralParent(node)) return;
      if (countWords(trimmed) >= 2) {
        const lc = sf.getLineAndCharacterOfPosition(node.getStart());
        const display =
          trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
        violations.push({
          file: path.startsWith(rootPath) ? path.slice(rootPath.length) : path,
          line: lc.line + 1,
          text: display,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

async function main(): Promise<void> {
  const all: Violation[] = [];
  for await (const file of walk(SCAN_DIR)) {
    all.push(...(await check(file)));
  }
  if (all.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `i18n JSX gate failed — ${all.length} hardcoded JSX text node(s):`,
    );
    for (const v of all) {
      // eslint-disable-next-line no-console
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(
    'i18n JSX gate OK — no hardcoded JSX text in apps/web/src.',
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
