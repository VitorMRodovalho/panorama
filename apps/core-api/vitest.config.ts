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
    // One worker at a time: the e2e files share one Postgres and reset
    // it per file, so they must not overlap. Vitest 4 replaced
    // `poolOptions.forks.singleFork` with `maxWorkers`; `isolate` stays
    // at its default (true) so every file still gets a fresh module graph.
    maxWorkers: 1,
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
      // Re-baselined 2026-10-09 for the vitest 4 instrument change, not a
      // coverage loss: vitest 4 remaps V8 coverage by AST, so it counts
      // real statements only (15930 -> 4999 statements for the same 525
      // tests). Same suite, both instruments:
      //   vitest 3: statements 84.07, branches 73.43, functions 87.38, lines 84.07
      //   vitest 4: statements 76.65, branches 65.54, functions 82.02, lines 79.38
      // (previous baseline, 2026-04-26 / #70, vitest 3: 83.86 / 72.55 / 81.68 / 83.86)
      // Floors below set just under each vitest 4 value, rounded down to
      // the nearest 5. Ratchet UP only from here — see CONTRIBUTING.md
      // "Threshold ratchet".
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 80,
        branches: 65,
      },
    },
  },
});
