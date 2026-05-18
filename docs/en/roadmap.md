# Roadmap

Where Panorama is going, at a glance. Strategic milestones only —
the implementation detail (PRs, ADRs, audit waves) lives in the
repo for anyone who wants to dig.

## Available today (open source, self-host)

The core fleet and IT-asset story works end-to-end on a
self-hosted Panorama:

- Multi-tenant by construction — row-level isolation enforced at
  the database layer, not just the app layer
- Reservations with conflict checks, approvals, blackouts,
  multi-asset baskets
- Check-in / check-out with mileage tracking, damage flagging,
  automatic routing to maintenance
- Asset maintenance tickets — flag, assign, track repair
- Photo inspections with configurable checklists and EXIF strip
- OIDC login (Google + Microsoft), email/password fallback
- CSV export from every list view, audit trail on every write
- Trilingual UI (EN / PT-BR / ES) — every user-facing string
  translated; CI blocks PRs that hardcode a language
- Snipe-IT API compatibility shim for read-heavy migrations

See the [self-hosting guide](./self-hosting.md), the
[feature matrix](./feature-matrix.md), and the
[Snipe-IT migration path](./migration-from-snipeit.md).

## Next: hosted preview opens

The maintainer's hosted Panorama instance — free, no SLA — opens
publicly once the public-preview readiness checklist closes
(observability + structured logs shipped; runbooks, privacy
policy, and status page remain). Early-access details and the
notify-me address at [/en/early-access](./early-access.md).

Same codebase runs on the hosted preview as you'd self-host.

## After preview: foundations + native mobile

- **Wave A** — teams + asset-to-user/team assignment (per ADR-0027 schema work)
- **Wave B** — native driver mobile app (React Native / Expo;
  offline-first inspections is the wedge) per ADR-0022
- **Wave C** — dispatcher power tools (calendar drag, bulk approve,
  affected-reservations view from maintenance ticket)
- **Wave D** — fleet-manager dashboard + 5 canned reports
  (utilisation, mileage, maintenance cost, missed reservations,
  damage incidents)
- Saved-report builder with CSV / XLSX / PDF render, schedulable
- Notification channels — email, Slack, Microsoft Teams, webhooks
- Bounce-webhook integration so invitation state stays accurate

## 1.0 — comfortable for non-pioneering deployments

1.0 is the point where Panorama is comfortable enough for a
mid-sized fleet operator who isn't part of the pioneer cohort.
The major identity and ergonomics gaps close:

- SAML, LDAP, SCIM 2.0 provisioning
- WebAuthn passkeys
- Barcode / label designer (SVG templates)
- Public plugin SDK with reference plugins shipped
- Threat model published; SOC-2 Type I in progress

## Beyond 1.0

- Predictive maintenance (Enterprise)
- Additional locales beyond EN / PT-BR / ES
- Multi-region read-replica architecture (Enterprise)

## How we say no

Not every Snipe-IT or FleetManager feature is in the plan. A
feature is dropped if it meets **any** of:

- Used by fewer than 5% of tracked Snipe-IT installs
- Has a cleaner analogue in the modern stack (e.g. Spatie
  app-level backups → native Postgres point-in-time recovery +
  object-store lifecycle rules)
- Creates an ops burden out of proportion to its value

Dropped features are tracked in [`dropped-features.md`](./dropped-features.md).
