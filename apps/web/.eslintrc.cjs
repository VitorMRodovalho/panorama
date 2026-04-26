/** @type {import('eslint').Linter.Config} */
// ESLint legacy config for @panorama/web (Wave 2d.B / #67 / extends
// Wave 1 #39).
//
// Pinned to ESLint 8 + eslint-config-next@14.2.35 because Next 14.2's
// shipped eslint-config uses the legacy `.eslintrc` format. Mixing
// ESLint 9's flat-config with it requires `FlatCompat` glue and is
// fragile — the workspace isolates this config from core-api's
// ESLint 9 via pnpm hoist boundaries, so the two majors coexist.
//
// Bump to ESLint 9 + flat config when this app moves to Next 15
// (tracked separately under #79).
module.exports = {
  root: true,
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended',
  ],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Permissive starting posture matching apps/core-api/eslint.config.mjs
    // — ratchet later via #101 follow-up.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Next's React-Server-Components patterns confuse the rule.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Apostrophes / quotes inside JSX text. Pre-i18n the entire web
    // app is being moved to packages/i18n (Wave 1 #44 — ~80% of web
    // strings still hardcoded English). Forcing the manual escape
    // dance now would churn lines that will be replaced wholesale
    // when each route gains its locale bundle. Re-enable once the
    // i18n migration lands.
    'react/no-unescaped-entities': 'off',
    // i18n: hardcoded strings are caught by the i18n-coverage CI step,
    // not by ESLint.
  },
};
