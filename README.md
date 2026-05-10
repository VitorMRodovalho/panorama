# Panorama

> One open-source platform for **IT assets + operational fleet** — laptops, vehicles, licenses, equipment, in one pane.
> Multi-tenant Postgres RLS, OIDC, hash-chained audit trail, trilingual EN/PT-BR/ES.
> AGPL-3.0 (fork-friendly). Free hosted preview coming.

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

Most teams that manage both IT assets (laptops, licenses, phones) and operational equipment
(vehicles, forklifts, tools) end up running two separate systems — two databases, two auth
surfaces, two audit trails, duplicate users, and a brittle integration between them.

Panorama is one platform for both. Single domain model, single data plane, single admin surface.
Multi-tenant from construction (Postgres RLS forced at every tenant-scoped table). Hash-chained,
tamper-detected audit log. Trilingual UI from day one (EN/PT-BR/ES). Self-host or use the
hosted preview.

## Status

🚧 **Early access — open for use, expect rough edges.** Bootstrapped 2026-04-17.

- **Backend:** production-ready (NestJS 11 + Prisma 6 + Postgres RLS + OIDC end-to-end tested
  via [#92](https://github.com/VitorMRodovalho/panorama/issues/92)). Dependency surface current
  through 2026-05-09 ([#123](https://github.com/VitorMRodovalho/panorama/issues/123)).
- **Web app:** in active build. ~10% of feature surface today; nav + asset CRUD + checkout
  forms in flight ([#52](https://github.com/VitorMRodovalho/panorama/issues/52)).
- **Hosted preview:** opening when [Wave 0 readiness](./docs/audits/HANDOFF-2026-05-09-session-end.md)
  closes (Privacy + ToS + status page + audit-chain fix + data-export endpoint).

Architecture decisions in [`docs/adr/`](./docs/adr/); current state + wave plan in
[`docs/audits/HANDOFF-2026-05-09-session-end.md`](./docs/audits/HANDOFF-2026-05-09-session-end.md).

## Project health & audit trail

A three-wave QA/QC audit was completed on 2026-04-23 covering security, architecture, data,
UX, ops, product strategy, supply-chain, and AI/MCP exposure. 126 findings documented; most
high/medium-priority items resolved across the audit-resolution sprint and the 2026-05-09
deps + Supabase staging session.

**Latest handoff** with current wave plan: [`docs/audits/HANDOFF-2026-05-09-session-end.md`](./docs/audits/HANDOFF-2026-05-09-session-end.md)
**Original audit punch list:** [`docs/audits/HANDOFF-2026-04-23.md`](./docs/audits/HANDOFF-2026-04-23.md).
Wave reports under [`docs/audits/`](./docs/audits/); filter open issues by
[`audit:wave-1`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-1),
[`audit:wave-2`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-2),
or [`audit:wave-3`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-3).

## Editions

| Edition       | License       | Source     | Use case                                                             |
|---------------|---------------|------------|----------------------------------------------------------------------|
| **Community** | AGPL-3.0      | This repo  | Full self-hosting for any size team, no feature gating on core flows |
| **Enterprise**| Commercial    | Private repo `panorama-enterprise` (pulled at build time) | SSO connectors for niche IdPs, SOC-2 audit packs, white-label, 24×7 support |
| **Hosted preview** | Free (early access) | Run by us | Free hosted instance for evaluation; opening when Wave 0 readiness closes (see latest handoff) |

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
| **Importers** | **Shipped:** CSV importer + `panorama-migrator` CLI with adapters for upstream IT-asset and fleet systems. |
| **API** | **Shipped:** REST under NestJS, typed OpenAPI auto-generated. PAT-authenticated compatibility shim for legacy IT-asset clients. **Planned (0.4+):** webhooks with HMAC. GraphQL is **not** on the roadmap — REST + OpenAPI is the contract. |
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

## Importing data from another system

If you're coming from another IT-asset or fleet system, Panorama ships a CSV importer plus
a `panorama-migrator` CLI in `packages/migrator` that adapts common upstream shapes
(API + MySQL dump readers) into Panorama fixtures. Existing integrations can keep working
during transition via the PAT-authenticated compatibility API shim.

See [`packages/migrator/README.md`](./packages/migrator/README.md) for the current adapter
list and CLI flags.

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
