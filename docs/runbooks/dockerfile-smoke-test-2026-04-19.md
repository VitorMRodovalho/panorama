# Dockerfile smoke-test report — 2026-04-19

> **Status update 2026-04-19**: blockers RESOLVED in commit
> `b858c31 fix(deploy): unblock prod boot — drop type:module +
> dynamic-import file-type`. Image now boots cleanly; /health returns
> 200. The fix path was different from Options A/B documented below
> — see "What actually fixed it" at the bottom.

Phase 2 of the deploy series (per ADR-0013) was a local smoke-test of
`apps/core-api/Dockerfile`. The image builds. The container originally
did NOT boot to a passing /health. Two ESM/CJS-interop blockers
discovered:

## What works

- Multi-stage build completes (~456 MB final image).
- `pnpm install --frozen-lockfile` succeeds in the builder stage.
- `prisma generate` runs in the builder stage.
- `pnpm exec turbo run build --filter='@panorama/core-api...'`
  builds workspace deps in topological order (was a real fix —
  earlier `pnpm --filter @panorama/core-api build` failed because
  `@panorama/shared/dist/` doesn't ship in the build context).
- `pnpm deploy --prod /out` produces a self-contained tree.
- The runner stage starts; tini + ca-certificates + postgresql-client
  install cleanly.

## What does NOT work (yet)

### Blocker 1 — Prisma client `.prisma/client/default` missing

`pnpm deploy --prod` doesn't copy `node_modules/.prisma/client/`
because pnpm doesn't recognise `.prisma/` as a real package. At
runtime, `@prisma/client` does `require('.prisma/client/default')`
and crashes with `MODULE_NOT_FOUND`.

**Workaround applied** — Dockerfile runs `npx --no-install prisma
generate` in the runner stage to regenerate the client into the
correct path. This builds successfully but doesn't unblock blocker 2.

### Blocker 2 — ESM/CJS interop with mixed dependencies

`apps/core-api/package.json` declares `"type": "module"`. Some
dependencies are ESM-only (`file-type` 19), others are CJS-only
(`@prisma/client` 5.22). Production-compiled output cannot satisfy
both at the same time:

- **With `type: "module"` (current)**: compiled output is ESM,
  named imports from `@prisma/client` fail
  (`SyntaxError: Named export 'Prisma' not found`).
- **Without `type: "module"`**: compiled output is CJS, `require()`
  on `file-type` fails (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

Local development (vitest with swc-transform, `nest start --watch`)
sidesteps the issue via the transform layer. Production raw-Node
loading exposes it.

## Path forward (next code PR)

Two viable fixes; pick one in a follow-up:

### Option A — Wrap `@prisma/client` imports

Change every `import { Prisma, PrismaClient } from '@prisma/client'`
to:

```typescript
import pkg from '@prisma/client';
const { Prisma, PrismaClient } = pkg;
```

20 files in `apps/core-api/src/`. Mechanical sed-able. Keep
`type: "module"` so file-type's ESM-only export keeps working.

### Option B — Local prisma-shim module

Create `apps/core-api/src/lib/prisma-pkg.ts`:

```typescript
import pkg from '@prisma/client';
export const { Prisma, PrismaClient } = pkg;
export type * from '@prisma/client';
```

Then a single `from '@prisma/client'` → `from '../lib/prisma-pkg.js'`
sweep across the 20 files. One indirection, but easier to keep
consistent + lint against re-introducing direct imports.

## What landed in this commit anyway

- Dockerfile `RUN pnpm exec turbo run build --filter='@panorama/core-api...'`
  (the workspace-build-order fix — improvement regardless of the
  ESM blocker).
- Dockerfile `RUN npx --no-install prisma generate` in runner stage
  (the .prisma/client regen — improvement regardless).
- `CMD ["node", "dist/src/main.js"]` (corrects the path; tsc with
  `rootDir: "."` produces `dist/src/main.js`, not `dist/main.js`).
- HEALTHCHECK `start-period=45s` (was 30s; Nest cold-boot under
  ESM resolution can take longer than expected).
- `apps/core-api/package.json` `main` + `start` corrected to
  `dist/src/main.js` (were stale `dist/main.js`; never noticed
  because `start` is unused — `dev` uses `nest start --watch`).
- This runbook documenting the findings + open follow-ups.

The smoke-test for prod-image boot is **NOT YET PASSING**. Self-host
operators following `docs/en/self-hosting.md` will hit blocker 2 on
first `docker compose up core-api`. The fix path above lands in a
follow-up code PR scoped specifically to the import refactor.

## Why not block on this

The user's plan order is (1) ADR-0015 implementation → (2) smoke-test
→ (3) step 11 web UI. The smoke-test was scoped as a 15-minute
sanity check. The discovered blockers turn it into a multi-hour
import-refactor PR that's its own thing. Documenting + moving on
keeps phase 3 unblocked. Self-hosters who want a deployable image
TODAY can follow option A or B from this runbook.

## What actually fixed it (post-mortem)

Both Options A and B were attempted and abandoned — both kept
`type: "module"` and tried to wrap the CJS-only `@prisma/client`,
which hit TypeScript's namespace-vs-type-alias issue with `Prisma`
(a value namespace + typing surface that doesn't merge cleanly via
`export const Prisma + export type *`).

The flipped approach in commit `b858c31` is a 2-line diff and works:

- `apps/core-api/package.json`: drop `"type": "module"`. tsc with
  `module: "NodeNext"` now emits CJS (NodeNext picks the effective
  module style from package.json). All 20 `@prisma/client` imports
  stay verbatim and compile to `require()`.
- `photo-pipeline.service.ts`: `import { fileTypeFromBuffer } from
  'file-type'` becomes a lazy `await import('file-type')` (cached
  after first call). file-type is the only ESM-only dep we use; if
  more land later, each gets the same lazy-import treatment in its
  single consumer file.

**Lesson**: when most deps are CJS and a small minority are ESM-only,
flip the build to CJS and lazy-import the ESM minority. The reverse
(ESM build + wrap CJS deps) is what intuition suggests but it's the
harder path under TypeScript's typing rules for value+namespace
exports.

Smoke verified: `docker run … panorama-core-api` boots, all modules
init, `/health` returns `{"ok":true,"db":"up"}` HTTP 200. Production-
mode HTTPS guard correctly refuses http:// S3_ENDPOINT (by design —
the SSRF DNS-resolve guard at object-storage.config.ts:60-65).
