import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// First test infra for @panorama/web (Round 4 PR1, per
// HANDOFF-2026-05-16-wave0-scan.md §Round 4 + tech-lead C3).
// Mirrors apps/core-api/vitest.config.ts shape; jsdom env replaces
// node so React DOM renders cleanly.
//
// `server-only` is aliased to an empty shim because Next 16's
// server-component files import it as a marker — vitest evaluates
// those modules outside a Next runtime and the upstream `server-only`
// package throws on import in any non-server-runtime env. The shim
// is harmless for tests: the marker exists to fail BUILD if a
// client component imports it, which isn't a concern under vitest.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './test/_shims/server-only.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/_setup.ts'],
    css: false,
  },
});
