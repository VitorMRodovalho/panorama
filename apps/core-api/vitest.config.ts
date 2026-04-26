import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // Vitest runs tests through Vite, which uses esbuild by default.
  // esbuild does NOT emit TypeScript decorator metadata, which breaks
  // NestJS's reflection-driven dependency injection. The SWC plugin
  // below enables the right transform so @Injectable / @Inject
  // constructor parameters resolve correctly in tests.
  plugins: [
    swc.vite({
      module: { type: 'nodenext' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: 'es2022',
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Sets FEATURE_INSPECTIONS=true and other env defaults BEFORE
    // any test file's static imports run. Required so AppModule's
    // module-load-time conditional sees the flag on.
    setupFiles: ['./test/_setup.ts'],
    // Coverage (Wave 2d.E / #70). Honest baseline thresholds —
    // ratchet UP only, never down (CONTRIBUTING.md "Migrations must
    // be reversible" sibling rule for coverage). Whole-project floor
    // is separate from CONTRIBUTING.md's per-file 80% rule for
    // touched files.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // src/ + scripts that ship at runtime. Test files, build
      // artefacts, and Prisma seeds are excluded.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/main.ts',
        'src/scripts/**',
        'prisma/**',
      ],
      // Honest baseline as of 2026-04-26 (PR landing #70):
      //   statements 83.86%, branches 72.55%, functions 81.68%, lines 83.86%
      // Floors below set just under each, rounded down to the nearest 5.
      // Ratchet UP only — see CONTRIBUTING.md "Threshold ratchet".
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
