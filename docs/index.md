---
layout: home
hero:
  name: Panorama
  text: Run your IT assets and your operational fleet from one place.
  tagline: Open source (AGPL-3.0). Trilingual EN / PT-BR / ES. Self-host it, or use the maintainer's hosted preview while we shape it with operators.
  actions:
    - theme: brand
      text: Get a hosted account
      link: /en/early-access
    - theme: alt
      text: Self-host on GitHub
      link: https://github.com/VitorMRodovalho/panorama
---

> **Early access** — real product, rough edges, weekly contact with the team. Bring real fleet data, expect rough edges, talk to us weekly.

## What works today

- **Multi-tenant isolation** — your data is yours, enforced at the DB layer (Postgres Row-Level Security + Prisma middleware, two independent layers)
- **Vehicle / equipment booking** with conflict checks, approvals, blackouts, basket-style multi-asset requests
- **Check-in / check-out flow** with mileage tracking + damage flagging
- **Photo inspections** — configurable checklists, EXIF strip, photo evidence (gated behind a flag we'll turn on with you)
- **OIDC login** — Google + Microsoft, end-to-end tested
- **CSV export** from every list view; full audit trail per record
- **Trilingual UI** — EN / PT-BR / ES, every user-facing string in i18n bundles (CI blocks PRs that hardcode English)

## What's rough

- No admin UI for inviting users yet — email and we'll add your team
- Calendar UI is functional, not pretty
- Asset add / edit screens land in the next 30 days
- We back up nightly; no point-in-time recovery yet — don't store the only copy of irreplaceable data here
- We may need to wipe and recreate the database during this preview — 30 days notice if so
- Photo uploads run synchronously today; under heavy load the request thread is busy
- Weekly contact: we want to hear what's broken; that's the deal

## Two journeys, one repo

**Hosted preview** — the maintainer runs a Panorama instance you can try for free. No SLA. Data may be wiped with 30 days notice (per [ADR-0014](/adr/0014-public-hosted-instance)). Great for evaluating, not for storing irreplaceable data yet.

**Self-host** — AGPL-3.0 fork-friendly. See the [self-hosting guide](/en/self-hosting), the [feature matrix](/en/feature-matrix), and the [migration-from-Snipe-IT path](/en/migration-from-snipeit). The codebase deployed on the hosted preview is identical to what you'd self-host.

## Trust

- [Public roadmap](/en/roadmap) — what's coming, what's deferred
- [Architecture decisions](/adr/0000-index) — every load-bearing choice with reasoning
- [Security contact](mailto:security@vitormr.dev) — disclosure policy at [SECURITY.md](https://github.com/VitorMRodovalho/panorama/blob/main/SECURITY.md)
- [Open issues](https://github.com/VitorMRodovalho/panorama/issues) — public bug tracker

## Language

EN · [PT-BR](/pt-br/) · [ES](/es/)
