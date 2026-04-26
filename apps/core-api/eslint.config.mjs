// ESLint flat config for @panorama/core-api (Wave 2d.A / #66 /
// extends Wave 1 #39).
//
// Strategy:
//   - typescript-eslint `recommendedTypeChecked` as the baseline.
//   - Real-bug catches as `error` — these surface concrete defects
//     not stylistic preferences.
//   - Stylistic / "this might be unsound" rules as `warn` initially
//     so the lint job can land without churning every file. Ratchet
//     to `error` in follow-up PRs.
//   - `--max-warnings=0` (set on the CLI side) makes every warning
//     a CI fail in steady state — the moment a contributor can't
//     ignore the warning, it stops accumulating.
//   - Tests relax `no-unsafe-*` (they construct lots of partial
//     mocks that the type system can't prove safe).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'prisma/migrations/**',
      'node_modules/**',
      // Generated Prisma artifacts under @prisma/client live in
      // node_modules/.prisma but a stray check-in could land in src/
      // — exclude defensively.
      '**/*.generated.ts',
      // Vitest config is a Vite-style mjs/ts at workspace root and is
      // not in any tsconfig's "include" — type-aware lint can't parse
      // it without forcing a tsconfig change.
      'vitest.config.ts',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `projectService: true` (TS-ESLint v8 mode) auto-discovers
        // tsconfig.json without requiring per-rule project paths.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Real-bug catches — these are why lint exists.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      // Permissive (off, not warn) — large pre-existing surface and
      // CI uses --max-warnings=0. Ratchet to warn → error in
      // follow-up cleanup PRs scoped per-module so the ratchet can
      // bisect cleanly. Tracking issue: TBD.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Allow `_unused` parameter convention (Nest decorators often
      // require unused-but-typed params). Off in src for the same
      // reason as above; the typecheck still flags genuinely-dead
      // identifiers via `noUnusedLocals` in tsconfig if enabled.
      '@typescript-eslint/no-unused-vars': 'off',
      // NestJS lifecycle hooks (`onModuleInit`, `onModuleDestroy`)
      // and controller handlers are async by framework contract
      // even when their body needs no await. False-positive density
      // is too high to keep the rule on; rely on `no-floating-promises`
      // to catch the real bugs.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests construct partial mocks the type-checker can't fully
    // model. Relax the unsafe rules instead of forcing every
    // fixture to be a Pick<T, …>.
    files: ['test/**/*.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Vitest's expect().rejects.toThrow() is a thenable; the
      // floating-promise catch fires false-positives in tests.
      '@typescript-eslint/no-floating-promises': 'off',
      // Mock methods are async-by-signature for shape compatibility
      // with the real interface; bodies often don't await anything.
      '@typescript-eslint/require-await': 'off',
      // Test patterns frequently use Promise.reject('shape') to
      // inject an arbitrary error shape into a mock; the rule's
      // requirement that the reason be an Error is too strict.
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      // Chai-style `expect(...)` short-circuits look like unused
      // expressions to the rule. Vitest uses different patterns
      // but a few legacy-shaped lines remain pre-cleanup.
      '@typescript-eslint/no-unused-expressions': 'off',
      // Setup-and-discard fixtures are common in cross-tenant
      // tests (a tenantBravo seeded so the cross-tenant case has
      // something to reject against, but not consumed by every it).
      // Disable the gate in tests; the typecheck still flags genuinely-
      // dead identifiers.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
