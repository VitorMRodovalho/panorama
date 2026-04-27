// ESLint flat config for @panorama/web (#109 — migrated from
// `.eslintrc.cjs` ahead of Next 16 / `next lint` removal).
//
// Strategy: `eslint-config-next` and `@typescript-eslint` still ship
// in legacy-config shape today (no flat-config export as of Next
// 15.5.15). Wrap their legacy configs through `FlatCompat` rather
// than hand-rolling equivalents — when upstream ships flat, swap
// the compat lines for direct imports without churning consumers.
//
// `pnpm --filter @panorama/web lint` now runs `eslint .` directly
// instead of `next lint`, which deprecates in Next 16.

import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'eslint.config.mjs',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
  ...compat.extends('plugin:@typescript-eslint/recommended'),
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Permissive starting posture matching apps/core-api's pre-#101
      // ratchet baseline — this surface hasn't been ratcheted yet.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Next's React-Server-Components patterns confuse the rule.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Apostrophes / quotes inside JSX text. The trilingual migration
      // (#44) is now complete, so we COULD re-enable, but enabling
      // would churn JSX text nodes that came in via i18n bundles
      // (translators don't always escape entities). Re-evaluate as a
      // separate cleanup pass.
      'react/no-unescaped-entities': 'off',
      // i18n: hardcoded JSX text is caught by `pnpm i18n:jsx-gate`
      // (added in #149), not by ESLint.
    },
  },
];
