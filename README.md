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

## Feature pillars — what's shipped vs. building vs. planned

> Shipped = works end-to-end today. Building = in active development for 0.3.
> Planned = on the roadmap (0.4+); cite the version next to the feature.

| Pillar | Status (0.3-pre-pilot, 2026-04-26) |
|--------|------------------------------------|
| **Assets** | **Shipped:** core schema, Categories, Manufacturers, Models, tag prefix, vehicle fields. **Planned (0.4+):** Snipe-IT parity for Custom Fields & Fieldsets, Suppliers, Depreciation, Status Labels, Acceptance / EULA. |
| **Bookings** | **Shipped:** advance reservation with approval workflow, basket (multi-asset), blackouts, conflict detection under `FOR UPDATE` SERIALIZABLE. **Building:** blackout management UI, overdue detection sweep + UI signal. **Planned (0.4+):** recurring reservations, training compliance gating, configurable approval matrices. |
| **Inspections** | **Shipped:** configurable templates (per-tenant), photo evidence with EXIF strip, snapshot-based item versioning, FAIL-review workflow, photo retention sweep. **Planned (0.4+):** signature capture, offline-first on mobile, pre/post comparison. |
| **Maintenance** | **Building:** manual ticket open / list / close + asset-status flip (ADR-0016 step 3+). **Planned (0.4+):** auto-suggest from FAIL inspection or damage flag, mileage/time-based PM alerts, vendor-side portal. |
| **People** | **Shipped:** Users, TenantMembership with role + status, OIDC + email/password auth, invitation flow. **Planned (0.4+):** SCIM 2.0, IdP-driven group mapping. SAML/LDAP not on roadmap pre-1.0 — see `PILOT-SCOPE-LOCK-2026-04-26.md`. |
| **Multi-tenancy** | **Shipped:** Postgres RLS at query layer, `panorama.current_tenant` GUC enforced via `runInTenant`, FORCE RLS on every tenant-scoped table, cross-tenant FK trigger. |
| **Auth** | **Shipped:** OIDC (Google + Microsoft Entra) with `email_verified` gate + Workspace `hd` override, email/password with argon2id, Personal Access Tokens for Snipe-IT compat. **Planned (0.4+):** SAML, WebAuthn. |
| **Notifications** | **Shipped:** internal event bus (`panorama.*.*`), per-event channel registry, hash-chained tamper-audit, invitation email channel. **Planned (0.4+):** Slack/Teams/PagerDuty connectors, webhook delivery with HMAC, reservation lifecycle emails. |
| **Reports** | **Planned (0.4+):** save-as-view, schedule, email; CSV/XLSX/PDF export. Nothing shipped today. |
| **Labels/Barcodes** | **Planned (0.4+):** server-side SVG rendering, per-tenant templates. Nothing shipped today. |
| **Importers** | **Shipped:** CSV importer + `panorama-migrator` CLI for Snipe-IT API + SnipeScheduler-FleetManager MySQL dump → fixtures. |
| **API** | **Shipped:** REST under NestJS, typed OpenAPI auto-generated, Snipe-IT compat shim with PAT auth. **Planned (0.4+):** webhooks with HMAC. GraphQL is **not** on the roadmap — REST + OpenAPI is the contract. |
| **Observability** | **Shipped:** structured JSON logging via Pino, audit-event hash chain, vitest coverage threshold. **Planned (0.4+):** OpenTelemetry tracing, Prometheus metrics, slow-query baseline runner. |
| **i18n** | **Shipped:** EN/PT-BR/ES framework + CI gate (every key must exist in all three locales). **Building:** ~80% of web strings still hardcoded English; the migration to fully-translated UI lands during pilot prep. |

## Architecture at a glance

```
+--------------------+
| apps/web (Next.js) |   apps/admin and apps/mobile are 0.4+ — not yet
+---------+----------+   committed; the web app handles admin flows today.
          |
          +-------- REST + OIDC session, /api/* proxy --------+
                                    |
                       +------------v-------------+
                       |  apps/core-api (NestJS)  |
                       |  domain modules + Prisma |
                       +------------+-------------+
                                    |
      +-----------+----------+------+------+---------------+
      |           |          |             |               |
   Postgres    Redis     Object Store   MailHog (dev)   BullMQ
   (Prisma,   (rate-     (MinIO; S3       SMTP relay     (in-process,
   RLS, GUC)  limits,     in prod)        outbound        Redis-backed)
              queues)                     email)
```

**OpenSearch + NATS / event bus + plugin SDK runtime** are 0.4+ targets,
not shipped today. See `docs/audits/PILOT-SCOPE-LOCK-2026-04-26.md` for
the explicit won't-ship-for-pilot list.

Deployment topologies:

- **Single-node Docker Compose** — `infra/docker/compose.dev.yml` for dev,
  `compose.prod.yml` for self-hosted. Shipped today.
- **Supabase / managed Postgres** — design landed (ADR-0013 + 0015),
  staging not yet provisioned. 0.3 deploy-prep work in progress.
- **Kubernetes + Helm**, **Terraform blueprints** — 0.4+, not started.

See [`docs/adr/0001-stack-choice.md`](./docs/adr/0001-stack-choice.md) for the stack rationale,
[`docs/adr/0013-staging-deploy-architecture.md`](./docs/adr/0013-staging-deploy-architecture.md) for deploy planning,
and [`docs/audits/HANDOFF-2026-04-23.md`](./docs/audits/HANDOFF-2026-04-23.md) for the prioritised pre-pilot punch list.

## Getting started (dev)

```bash
# Pre-req: Node 22+, pnpm 9+, Docker, Docker Compose v2
corepack enable
pnpm install
cp apps/core-api/.env.example apps/core-api/.env
docker compose -f infra/docker/compose.dev.yml up -d
pnpm --filter @panorama/core-api prisma migrate dev
pnpm dev
```

Then:

- Web app:  http://localhost:3000
- Core API: http://localhost:4000
- API docs: http://localhost:4000/api/docs (OpenAPI UI)
- MailHog (dev SMTP):  http://localhost:8025
- MinIO console (dev): http://localhost:9001 (credentials in `.env.example`)

**Contributor security note:** if you use Cursor / Claude Desktop /
any AI tool with MCP servers configured against this repo, read
[`docs/runbooks/dev-environment-ai-tooling.md`](./docs/runbooks/dev-environment-ai-tooling.md)
before running anything. The runbook lists the verified MCP server
allowlist and the incident-response path.

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
