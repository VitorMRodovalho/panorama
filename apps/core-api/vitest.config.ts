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
  },
});
