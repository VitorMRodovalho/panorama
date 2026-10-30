# syntax=docker/dockerfile:1
# Panorama core-api production image.
#
# Multi-stage:
#   1. builder — installs full workspace deps, runs prisma generate + nest build,
#      then pnpm-deploys a self-contained `/out` dir with prod-only deps + dist.
#   2. runner  — minimal node:24-trixie-slim with tini as PID 1, runs as
#      non-root `node`, exposes 4000.
#
# Sharp's prebuilt binaries are the glibc ones — that's why we're on a Debian
# slim image, not alpine. Alpine would force a from-source rebuild of sharp + vips-dev.
#
# Build:   docker build -f apps/core-api/Dockerfile -t panorama-core-api .
# Run:     docker run --env-file .env -p 4000:4000 panorama-core-api
# Compose: see infra/docker/compose.prod.yml

# ---------------------------------------------------------------------------
# Stage 1 — builder
# ---------------------------------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS builder

ENV CI=1
WORKDIR /repo

# pnpm's documented way to add it to an image: copy /opt/pnpm (it carries
# the node-gyp pnpm uses for native builds) from the official image whose C
# library matches ours (Debian -> the non-alpine tag). Keep the tag equal
# to `packageManager` in package.json; on a mismatch pnpm downloads the
# declared version (pmOnFail: download).
COPY --from=ghcr.io/pnpm/pnpm:12.16.1@sha256:33081d3d2c96ba582d316cfd630f0f43961d9c60ff919b50edd1835a1462976b /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

# Workspace manifests first → maximal Docker layer cache reuse on source-only edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/core-api/package.json apps/core-api/
COPY packages/migrator/package.json packages/migrator/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui-kit/package.json packages/ui-kit/

# Install full workspace (dev + prod) so prisma generate + nest build can run.
RUN pnpm install --frozen-lockfile

# Source — `apps/core-api/` + `packages/` only; web is built in its own image.
COPY apps/core-api/ apps/core-api/
COPY packages/ packages/

# Prisma generate first (writes the client into node_modules). Then
# turbo-driven build with `--filter @panorama/core-api...` which
# picks up the workspace package dependencies (`@panorama/shared`,
# `@panorama/migrator`, `@panorama/plugin-sdk`) AND core-api in
# topological order. Without this, core-api's tsc fails to resolve
# `@panorama/shared` because shared/dist hasn't been emitted yet
# (`.dockerignore` excludes `**/dist` from the build context).
RUN pnpm --filter @panorama/core-api exec prisma generate
RUN pnpm exec turbo run build --filter='@panorama/core-api...'

# Deploy self-contained prod-only tree. `pnpm deploy --prod` resolves workspace
# deps (`workspace:*`) by inlining the actual package contents — no symlinks
# back to /repo, so the runner stage doesn't need the monorepo at all.
RUN pnpm deploy --filter @panorama/core-api --prod /out

# ---------------------------------------------------------------------------
# Stage 2 — runner
# ---------------------------------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS runner

# tini = PID 1 so signals (SIGTERM, SIGINT) propagate to node and shutdown
# hooks fire (Nest's onModuleDestroy, BullMQ worker.close, Prisma $disconnect).
# tini for PID 1 + ca-certificates for HTTPS to Postgres / S3 / etc +
# postgresql-client so the migrator compose service can apply rls.sql via
# `psql -f`. The client adds ~12 MB; documented as an acceptable cost so
# the image is single-purpose-multi-mode (runtime, migrator, ad-hoc psql).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

COPY --from=builder /out/dist        ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/prisma      ./prisma
COPY --from=builder /out/package.json ./
# The migrator service in infra/docker/compose.prod.yml runs
# /app/scripts/apply-migrations.sh; `pnpm deploy` does not copy scripts/.
COPY --from=builder /repo/apps/core-api/scripts ./scripts

# `pnpm deploy --prod` doesn't copy the Prisma-generated client out
# of the builder's `node_modules/.prisma/client/` directory (the
# generated files live alongside @prisma/client but in a hidden
# `.prisma` subdir that pnpm doesn't recognise as a real package).
# Re-run `prisma generate` here so the runtime image has the
# generated .prisma/client/default module @prisma/client expects.
# Invoke via npx (ships with node) to avoid adding pnpm to the
# runner image just for this step.
RUN npx --no-install prisma generate

# Run as the Debian node image's pre-seeded `node` user (uid 1000).
USER node

EXPOSE 4000

# /health is implemented by HealthModule. Exit non-zero on non-200 / fetch
# failure so the orchestrator (Fly, K8s, compose) can act on it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# tsc with `rootDir: "."` (apps/core-api/tsconfig.json) preserves the
# directory tree under `dist/`, so the compiled entry is
# `dist/src/main.js`, NOT `dist/main.js`. The package.json `main` /
# `start` fields are stale and shouldn't be relied on; the canonical
# entry is here.
CMD ["node", "dist/src/main.js"]
