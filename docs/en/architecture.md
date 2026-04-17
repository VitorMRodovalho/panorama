# Architecture

Audience: engineers joining the project, ops teams evaluating Panorama for
self-hosting. Kept deliberately code-focused; product/marketing lives in the README.

## 1. High-level

```
                    ┌────────────────────────────────────────────────┐
                    │                 Edge / CDN                     │
                    │       (Cloudflare / fronting nginx)            │
                    └────────────────────────────────────────────────┘
                                         │
        ┌────────────────────────────────┼─────────────────────────────────┐
        ▼                                ▼                                 ▼
 ┌──────────────┐              ┌──────────────┐                   ┌────────────────┐
 │ apps/web     │              │ apps/admin   │                   │ apps/mobile    │
 │ (Next.js 14) │              │ (Next.js 14) │                   │ (Expo/RN)      │
 └──────┬───────┘              └──────┬───────┘                   └────────┬───────┘
        │                             │                                    │
        └─────── OIDC cookie + REST ──┴────── REST + webhooks ─────────────┘
                                         │
                        ┌────────────────┴─────────────────┐
                        │        apps/core-api              │
                        │        (NestJS 10, Node 20)       │
                        │  ┌───────────────────────────┐    │
                        │  │  Domain modules:          │    │
                        │  │  auth, tenants, users,    │    │
                        │  │  assets, bookings,        │    │
                        │  │  inspections, maintenance,│    │
                        │  │  reports, notifications,  │    │
                        │  │  audit, plugin-host       │    │
                        │  └───────────────────────────┘    │
                        └────────────────┬─────────────────┘
                                         │
      ┌──────────────┬─────────────────┬─┴──────────────┬──────────────┐
      ▼              ▼                 ▼                ▼              ▼
 ┌─────────┐   ┌──────────┐    ┌───────────────┐  ┌──────────┐  ┌────────────┐
 │ Postgres│   │ Redis    │    │ S3-compat     │  │ Search   │  │ Event bus  │
 │ 16      │   │ (cache,  │    │ object store  │  │ Postgres │  │ NATS JS /  │
 │ +RLS    │   │ BullMQ)  │    │ (photos,      │  │ FTS or   │  │ Redpanda   │
 └─────────┘   └──────────┘    │ backups)      │  │ OpenSearch│  └────────────┘
                                └───────────────┘  └──────────┘
```

### Request lifecycle

1. A logged-in user opens the web app; Next.js middleware validates the OIDC
   session cookie, extracts `tenant_id` and role, and forwards to the core-api
   with `X-Tenant-Id` and a short-lived JWT.
2. The core-api's `TenantMiddleware` sets `request.tenantId` and starts a
   Prisma transaction with `SET LOCAL app.current_tenant = $1` so RLS and
   Prisma middleware agree on the scope.
3. The controller resolves the use case, the domain module runs, writes go
   through Prisma (scoped by middleware), domain events are published to the
   event bus, jobs are queued in BullMQ.
4. Audit log rows are written synchronously in the same transaction as the
   mutation — if the transaction rolls back, the audit log rolls back with it.
5. Notifications fire **after commit** via an outbox pattern; a worker drains
   the outbox and retries on failure.

## 2. Data plane

Postgres 16 with:

- `pg_stat_statements`, `pgcrypto`, `uuid-ossp`
- `pgvector` (Enterprise-only for predictive maintenance embeddings)
- RLS enabled on every tenant-owned table (see ADR-0003)

Connection pooling via **PgBouncer** (transaction mode) on self-host deployments,
or **AWS RDS Proxy / Cloud SQL PgBouncer** on managed setups.

Schema lives in `apps/core-api/prisma/schema.prisma`. Migrations are Prisma
migrations + optional hand-written SQL for RLS policies (Prisma doesn't model
those natively).

## 3. Async work

All deferred work goes through BullMQ queues backed by Redis:

- `emails` — outbound SMTP (Snipe-IT + FleetManager both had email queues; we
  keep the pattern, tuned for idempotent retry)
- `webhooks` — outbound HTTP webhooks with HMAC signatures + exponential backoff
- `reports` — long-running report generation (CSV, XLSX, PDF)
- `sync` — third-party data sync (SCIM pushes, import jobs)
- `maintenance` — scheduled checks (training-expiry, overdue-return,
  sync-staleness — the equivalent of FleetManager's CRON suite)

Jobs are idempotent; the worker tier is horizontally scalable.

## 4. Event bus

Domain events (`panorama.asset.checked_out`, `panorama.reservation.approved`, etc.)
are published to NATS JetStream. Consumers include:

- Notification service (decides email / Teams / Slack / webhook)
- Audit log replicator (optional — streams to SIEM)
- Plugin host (delivers events to registered plugin subscribers)

Events are **retained for 7 days** by default; replay is supported for plugin
bootstrapping. In Community edition, NATS is optional — if disabled, events
are dispatched in-process synchronously and plugins still work (just without
replay).

## 5. Auth / authz

- **Session** — encrypted cookie (iron-session), per-tenant session secret,
  5-minute refresh.
- **OIDC / SAML** — handled by the `auth` module; OIDC via `oidc-provider`,
  SAML via `node-saml`. IdP group claims map to Panorama roles via a per-tenant
  `group_role_mapping` table.
- **API tokens** — short-lived (default 15 min) via OAuth2 client-credentials,
  plus long-lived (90 days max) personal access tokens that hash to
  sha256 in the DB.
- **Authorisation** — CASL 6. Every endpoint asks `Ability.can('update',
  asset)`. Abilities are built from the authenticated principal's role +
  plugin extensions.
- **2FA / WebAuthn** — TOTP always available in Community; WebAuthn +
  passkeys in Community; attestation-required WebAuthn (FIDO2 AAL-2) in
  Enterprise only.

## 6. Multi-tenancy

See ADR-0003. Short version:

- `tenant_id` (`company_id` in UI) on every tenant-owned table
- Prisma middleware injects the predicate
- Postgres RLS enforces the same at the DB layer
- Super Admin bypass is opt-in per request

## 7. i18n

- `packages/i18n/{en,pt-br,es}/*.json` — translation bundles, keyed by feature
- Frontend uses `next-intl`; backend uses `nestjs-i18n` for email / webhook
  templates
- CI check: every EN key must exist in PT-BR and ES; missing keys fail the
  build. A `scripts/i18n-check.ts` produces a coverage report per PR.
- Contributor flow: add keys in EN, open PR, CI shows missing translations, a
  Crowdin or Weblate integration fills them (decided in a later ADR).

## 8. Observability

- **Structured logs** — pino, JSON, correlation-id middleware
- **Traces** — OpenTelemetry → Jaeger / Tempo / any OTLP endpoint
- **Metrics** — Prometheus exposition at `/metrics` on the admin port
- **Error reporting** — Sentry optional, configured via env
- **Audit log** — append-only, hash-chained (each row's hash depends on the
  previous row's hash) to make tampering detectable

## 9. Plugin host

See ADR-0006. Plugins live in `plugins/` directory on the self-hosted install
or are installed via `panorama plugins install @vendor/foo`. Each plugin has:

- `manifest.json` — permissions, version range, events subscribed
- `server.ts` — NestJS dynamic module
- `client.tsx` — React slot components

Plugins run in-process in Community; Enterprise offers a sidecar mode for
isolation.

## 10. Deployment

### Single-node Docker Compose

`infra/docker/compose.prod.yml` spins up:

- `core-api` (1 replica)
- `worker` (1 replica)
- `web` (1 replica)
- `admin` (1 replica)
- `postgres`, `redis`, `minio`, `nats`

For teams up to ~100 users / 10k assets. No external dependencies.

### Kubernetes + Helm

`infra/helm/panorama` provides:

- `core-api` Deployment with HPA on CPU and custom metric `requests_in_flight`
- `worker` Deployment, HPA on queue depth
- `web`, `admin` as separate Deployments behind a shared Ingress
- Managed Postgres (not bundled — you plug in your RDS / Cloud SQL / Patroni)
- Redis / NATS via Bitnami charts or your own
- `ServiceMonitor` for Prometheus scraping

### Terraform blueprints

`infra/terraform/aws/` (GCP and Azure mirrors) provision:

- RDS Postgres (`db.t4g.medium` starter, encrypted)
- ElastiCache Redis
- S3 bucket with KMS + lifecycle rules
- VPC, subnets, security groups
- ECR repositories for images
- IAM roles for the worker tier

## 11. Migration from Snipe-IT / FleetManager

The `@panorama/migrator` package reads from:

- Snipe-IT **API** (no direct DB access; tokens authenticated per role)
- Optional SnipeScheduler-FleetManager MySQL dump for reservation history

It produces Panorama fixtures in JSON form, which a `panorama import-fixtures`
command loads into a target Postgres instance inside a transaction. Dry-run
mode prints a diff without touching the DB.

During the migration window (weeks, not minutes), a **compatibility shim**
exposes Snipe-IT-style endpoints (`/api/v1/hardware`, `/api/v1/users`, etc.) so
existing integrations keep working without rewrite. The shim is a read/write
proxy that translates to the Panorama native API.

## 12. Versioning

- **SemVer** for the platform (major / minor / patch)
- **Prisma schema versions** match the platform major.minor
- **API** versioned via `Accept: application/vnd.panorama.v1+json` header,
  not URL path (`/api/v1`)
- **Plugin SDK** has its own SemVer; compatible with a range of platform
  versions declared in each plugin's manifest
