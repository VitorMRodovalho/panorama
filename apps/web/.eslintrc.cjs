/** @type {import('eslint').Linter.Config} */
// ESLint legacy config for @panorama/web (Wave 2d.B / #67 / extends
// Wave 1 #39).
//
// Legacy `.eslintrc` format because eslint-config-next@15 still ships
// in this shape (Next has not migrated its config to flat). ESLint 9
// IS now the workspace-wide major (post-#79 Next 15 upgrade lifted
// the apps/web ESLint pin from ^8 to ^9), but the config file format
// stays legacy until eslint-config-next ships flat. Migrate this file
// when that lands; track via a separate follow-up issue.
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
