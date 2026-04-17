# ADR-0001: Stack choice — NestJS + Next.js + Postgres + Prisma

- Status: Accepted
- Date: 2026-04-17
- Deciders: Vitor Rodovalho, maintainers

## Context

Panorama is a greenfield rewrite of two existing PHP systems (Snipe-IT,
AGPL-3.0, Laravel; and SnipeScheduler-FleetManager, GPL-3.0, raw PHP).
We need a stack that:

- Attracts a **large contributor pool** (open-source viability)
- Supports **horizontal scaling** for SaaS hosting and plausible enterprise on-prem
- Has a **mature, typed ORM** that we can trust for row-level multi-tenancy
- Lets us share **typed DTOs between backend and frontend**
- Has **first-class i18n** primitives (we ship trilingual at launch)
- Has **good mobile paths** (React Native / Expo pulls from the same package graph)
- Is not locked into any single cloud vendor

We considered three realistic options. Details below.

## Decision

**TypeScript monorepo driven by pnpm workspaces + Turborepo:**

- **Backend:** NestJS 10 on Node 20, with BullMQ workers on a separate process
- **Frontend web (end-user + admin):** Next.js 14 App Router, React 18, Tailwind, shadcn/ui
- **Mobile:** React Native via Expo (deferred — ships in 1.1)
- **Database:** PostgreSQL 16, accessed via Prisma 5 (row-level tenancy enforced in
  Prisma middleware)
- **Cache / queues:** Redis 7 (+ BullMQ for deferred jobs and email queue)
- **Object store:** S3-compatible (MinIO in dev, AWS S3 / GCS / Azure Blob in prod)
- **Event bus:** NATS JetStream, optional in Community, recommended in Enterprise
- **Search:** OpenSearch, optional; Postgres FTS is the default

Shared code lives in `packages/*` (plugin SDK, UI kit, i18n bundles, shared
domain types). All packages are typed end-to-end; no `any` without an ESLint
justification comment.

## Alternatives considered

### Option A — Stay on PHP (Laravel 11)

- ✅ Cheapest migration path (SnipeScheduler is PHP; Snipe-IT is Laravel already)
- ✅ Laravel ecosystem has Passport, SCIM, SAML, Nova, etc.
- ❌ Contributor pool for modern OSS products skews JS/TS
- ❌ Weak mobile story (we'd need a second stack for React Native anyway)
- ❌ Type sharing between server and browser still awkward

Rejected because the long-term contributor-pool concern outweighs the short-term
migration cost, and because we're rewriting anyway (new schema, new UX), so the
"just fork Snipe-IT" shortcut is not actually available.

### Option B — Go (backend) + Next.js (frontend)

- ✅ Excellent runtime performance and static binaries for on-prem
- ✅ Tight concurrency primitives for event-heavy workloads
- ❌ Smaller OSS contributor pool for fleet/asset-domain SaaS apps
- ❌ No meaningful type sharing between server and browser without codegen
  yak-shaving
- ❌ ORMs for Go (ent, gorm, sqlc) are each a compromise; none gives us Prisma's
  DX + middleware story

Rejected for contributor-pool and DX reasons. Reconsidered if a perf bottleneck
appears that Node genuinely can't solve; mitigation is to rewrite that one
service in Go later (e.g. the event bus relay).

### Option C — Python (FastAPI + SQLAlchemy) + Next.js

- ✅ Huge contributor pool; strong data/ML adjacency (useful for predictive maintenance)
- ❌ Python's typing story is still weaker than TypeScript's for API contract sharing
- ❌ Two runtimes in the monorepo; harder onboarding
- ❌ SCIM/SAML server libraries are less battle-tested than Laravel-JS equivalents

Rejected for DX and single-language consistency.

## Consequences

### Positive
- Single language across web, admin, core API, plugin SDK, mobile → one toolchain, one CI
- Prisma + Zod + tRPC-or-OpenAPI gives us typed API contracts end-to-end
- The hiring market for TS/Nest is large and global
- Vercel / Cloudflare / Railway-style deploys all "just work" for the web tier

### Negative
- Node's CPU-bound performance is weaker than Go's; PDF generation and report
  aggregation may need workers with tuned concurrency
- `node_modules` size is a recurring ops cost (CI cache, Docker image size); we
  mitigate with pnpm + standalone Next.js builds
- Prisma has occasional migration-UX footguns; we will codify a migration
  review checklist

### Neutral
- NestJS is opinionated (modules, DI). It's a bet on structure over flexibility.
  For a 3+ year product, that trade favours us.

## Related

- [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md) (Prisma middleware choice is downstream of this)
- [ADR-0006 Plugin SDK](./0006-plugin-sdk.md) (SDK exposes typed hooks to NestJS modules)
