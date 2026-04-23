# Panorama

> Unified open-source platform for **IT asset management + operational fleet management**.
> The successor to running [Snipe-IT](https://snipeitapp.com) plus a bespoke scheduling overlay —
> one system, trilingual, self-hostable, API-first.

<p align="center">
  <em>One pane of glass for laptops, licences, phones, forklifts, vans, and everything in between.</em>
</p>

---

## 🌐 Read this in another language

- **English** — you are here
- **Português (Brasil)** — [README.pt-br.md](./README.pt-br.md)
- **Español** — [README.es.md](./README.es.md)

---

## Why Panorama?

Today, fleets that also have IT inventory tend to stitch together:

- **Snipe-IT** (Laravel, AGPL-3.0) — excellent IT asset management, weak on advance reservation workflows, weak on vehicle-specific fields
- **A custom overlay** like [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager) — bolted on top of Snipe-IT to handle reservations, inspections, driver training, multi-entity partitioning

Running both means two databases, two auth surfaces, two audit trails, duplicate users,
two upgrade paths, and a brittle HTTP boundary between them. Panorama absorbs both sets of
features into a single domain model, a single data plane, and a single admin surface.

## Status

🚧 **Pre-alpha — greenfield.** Bootstrapped 2026-04-17. Architecture and name open to review.
See [`docs/adr/`](./docs/adr/) for the decisions recorded so far.

## Project health & audit trail

A three-wave QA/QC audit was completed on 2026-04-23 covering security, architecture, data,
UX, ops, product strategy, supply-chain, and AI/MCP exposure. 126 findings documented, 61 open
as labelled GitHub issues. **Start at [`docs/audits/HANDOFF-2026-04-23.md`](./docs/audits/HANDOFF-2026-04-23.md)**
for the prioritised action list. Wave reports under [`docs/audits/`](./docs/audits/); filter
issues by [`audit:wave-1`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-1),
[`audit:wave-2`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-2),
or [`audit:wave-3`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-3).

## Editions

| Edition       | License       | Source     | Use case                                                             |
|---------------|---------------|------------|----------------------------------------------------------------------|
| **Community** | AGPL-3.0      | This repo  | Full self-hosting for any size team, no feature gating on core flows |
| **Enterprise**| Commercial    | Private repo `panorama-enterprise` (pulled at build time) | SSO connectors for niche IdPs, SOC-2 audit packs, white-label, 24×7 support |
| **Cloud**     | Managed SaaS  | Run by us  | Fastest onboarding, vendor-run Postgres + backups + patching         |

The **Community** edition is the reference implementation — everything in it must work
end-to-end without Enterprise code. Enterprise is **additive**, never subtractive.

## Feature pillars

| Pillar | From Snipe-IT we keep | From FleetManager we keep | Panorama adds |
|--------|-----------------------|---------------------------|---------------|
| **Assets** | Hardware/License/Accessory/Consumable/Component/Kits, Categories, Manufacturers, Models, Suppliers, Status Labels, Custom Fields & Fieldsets, Asset lifecycle events, Depreciation, Acceptance / EULA | Vehicle-first model, VIN/plate duplicate check, per-company tag prefix | Unified `assetable` abstraction so any asset type can be bookable |
| **Bookings**| — | Advance reservation with approval workflow, recurring reservations, blackouts, training compliance gating, VIP auto-approval, basket (multi-asset) booking | First-class calendar UX, conflict detection under `FOR UPDATE`, configurable approval matrices |
| **Inspections**| — | Configurable checklist (Quick 4 / Full 50-item / Off), photo evidence, EXIF strip, pre/post comparison | Arbitrary checklists per asset type, signature capture, offline-first on mobile |
| **Maintenance**| Asset maintenances | Maintenance flag at checkin, mileage/time-based alerts | Predictive alerts, per-asset-type schedules, vendor-side portal |
| **People** | Users, Groups, Departments, Locations, Companies, Permissions | Driver training validity, OAuth-by-email sync | SCIM 2.0, IdP-driven group mapping, per-company RBAC matrix |
| **Multi-tenancy**| Companies (row-level), per-company permission flag | Company-scoped vehicle/reservation filtering | Strict row-level tenancy at query layer + tenant-aware cache keys |
| **Auth**| LDAP, SAML, Google/Microsoft OAuth, Passport API tokens, 2FA | OAuth-only for web, API token for CLI | OIDC, SAML, SCIM provisioning, per-IdP group mapping, WebAuthn, short-lived API keys |
| **Notifications**| Email, Slack, Teams, Google Chat | SMTP + Teams per-event channels, overdue reminders, training expiry | Webhooks, PagerDuty, configurable event bus (`panorama.asset.checked_out`), queue-backed delivery |
| **Reports**| 20+ built-ins, CSV export | Utilization, compliance, driver analytics | ReportTemplate 2.0: save-as-view, schedule, email; export CSV/XLSX/PDF |
| **Labels/Barcodes**| QR + 1D barcode PDFs via TCPDF | — | Server-side SVG rendering, per-tenant templates |
| **Importers**| CSV for every major entity | — | Idempotent CSV with dry-run preview, `panorama migrate-from-snipeit` CLI |
| **API**| v1 REST (1,379 routes), Passport OAuth 2 tokens | — | REST + typed OpenAPI 3.1, GraphQL optional, webhooks with HMAC signatures |
| **Observability**| Activity log, Spatie backups | Activity log, CRON health monitor | OpenTelemetry tracing, Prometheus metrics, structured JSON logs |
| **i18n**| 50+ community translations | English only | First-class EN / PT-BR / ES, framework for contributors to add more |

## Architecture at a glance

```
+--------------------+     +--------------------+     +-----------------+
| apps/web (Next.js) |     | apps/admin (Next.js)|    | apps/mobile (RN)|
+---------+----------+     +---------+----------+     +--------+--------+
          |                           |                         |
          +------------ REST + webhooks, OIDC session ----------+
                                    |
                       +------------v-------------+
                       |   apps/core-api (NestJS) |
                       |  domain modules + plugin  |
                       |       SDK lifecycle       |
                       +------------+-------------+
                                    |
      +-----------+------------+----+---------+-----------------+
      |           |            |              |                 |
   Postgres    Redis       Object Store    OpenSearch       Event bus
   (Prisma)   (cache,      (photos,        (optional        (NATS JetStream
              queues via    uploads,         full-text        or Redpanda)
              BullMQ)       backups)         search)
```

Deployment topologies:

- **Single-node Docker Compose** — comes out of the box; hobbyist/small team
- **Kubernetes + Helm** — `infra/helm/panorama`; horizontal web + worker tiers, managed Postgres
- **Terraform blueprints** for AWS/GCP/Azure managed Postgres + object store

See [`docs/adr/0001-stack-choice.md`](./docs/adr/0001-stack-choice.md) for why NestJS + Next.js + Postgres + Prisma,
and [`docs/architecture.md`](./docs/en/architecture.md) for the full write-up.

## Getting started (dev)

```bash
# Pre-req: Node 20+, pnpm 9+, Docker, Docker Compose v2
corepack enable
pnpm install
cp apps/core-api/.env.example apps/core-api/.env
docker compose -f infra/docker/compose.dev.yml up -d postgres redis minio
pnpm --filter @panorama/core-api prisma migrate dev
pnpm dev
```

Then:

- Web app:  http://localhost:3000
- Admin:    http://localhost:3001
- Core API: http://localhost:4000
- API docs: http://localhost:4000/api/docs (OpenAPI UI)

## Migrating from Snipe-IT or SnipeScheduler-FleetManager

A migration CLI lives in `packages/migrator`. It reads from a running Snipe-IT v8+
instance via API (no direct DB access required) and, optionally, a
SnipeScheduler-FleetManager MySQL dump, and produces Panorama fixtures.

```bash
pnpm --filter @panorama/migrator cli \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --fleetmanager-dump ./snipescheduler_backup.sql \
  --out ./migrated
```

This is **not** a one-way trapdoor. Panorama also ships a Snipe-IT–compatible API
shim so existing integrations keep working while you migrate.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version:

1. Open an issue or pick one from the [roadmap](./docs/en/roadmap.md) first
2. Small PRs, clear commit messages (Conventional Commits), no 1,000-line drops
3. Every user-facing string must be in `packages/i18n/{en,pt-br,es}` — we block PRs that hardcode English
4. Every DB change must ship a Prisma migration plus a rollback note
5. Every new feature must declare its edition tier: `community` or `enterprise`

## License

Community edition is **AGPL-3.0-or-later**. The AGPL clause is deliberate — if you
run a hosted SaaS that modifies Panorama, you must share your changes. Enterprise
modules live in a separate private repo under a commercial licence.

See [LICENSE](./LICENSE) and [docs/en/licensing.md](./docs/en/licensing.md).

## Code of conduct

[Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).

## Credits

- Derived from work on [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager)
  by Vitor Rodovalho, itself a fork of [SnipeScheduler](https://github.com/JSY-Ben/SnipeScheduler) by Ben Pirozzolo.
- Feature coverage mapped against [Snipe-IT](https://github.com/grokability/snipe-it) (AGPL-3.0, © Grokability Inc.).
- Thanks to the OSS projects we depend on — see `THIRD_PARTY_NOTICES.md` at release time.
