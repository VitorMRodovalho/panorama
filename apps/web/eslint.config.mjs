// ESLint flat config for @panorama/web (#109 — migrated from
// `.eslintrc.cjs` ahead of Next 16 / `next lint` removal).
//
// Now uses direct flat-config imports (eslint-config-next 16 ships
// flat-shaped exports, so the FlatCompat shim from #109 is no longer
// needed). Kept the same rule surface — permissive matching apps/
// core-api's pre-#101 ratchet baseline.
//
// `pnpm --filter @panorama/web lint` runs `eslint .` directly; Next 16
// removed the `next lint` command.

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `eslint-config-next` 16 already bundles + configures `@typescript-eslint`
// (see its dependencies). Do NOT spread `tseslint.configs.recommended`
// here too — that re-registers the same plugin name and ESLint 10 hard-
// errors with `Cannot redefine plugin "@typescript-eslint"`.
export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'eslint.config.mjs',
    ],
  },
  ...nextCoreWebVitals,
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
