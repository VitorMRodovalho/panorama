# ADR-0006: Plugin / extension SDK boundary

- Status: Draft
- Date: 2026-04-17
- Deciders: Vitor Rodovalho

## Context

Both Snipe-IT and SnipeScheduler-FleetManager grew features by monkey-patching
the core: custom fields invented by users, niche workflows bolted onto the
booking code path, org-specific notification hooks. Panorama must support
extension without re-opening the core.

We need an SDK boundary that lets partners and the community:

- Add asset types (bookable, checkoutable, maintainable)
- Add approval steps to the booking workflow
- Add custom fields with server-side validators
- Subscribe to domain events
- Add UI extensions (custom settings pages, dashboard cards)
- Add import/export adapters (e.g. SAP Ariba connector)

…without a hard fork and without shipping C binaries.

## Decision (draft)

Ship `@panorama/plugin-sdk` as:

1. A set of **typed hook interfaces** (TypeScript) mirroring NestJS lifecycle
   events and domain events. Plugins register providers via NestJS dynamic
   modules.
2. A **UI extension surface** exposed as Next.js slot components; plugins
   export React components that load into named slots (`dashboard.cards`,
   `settings.panels`, `asset.profile.tabs`).
3. A **manifest.json** per plugin declaring required permissions, required
   env vars, and the Panorama version range it's compatible with.
4. A **plugin loader** that isolates plugin code in a separate Node VM
   context, with a capability-based permission model (read-only, write-own,
   write-all, invoke-webhook).
5. A **well-known event catalog** that plugins can subscribe to without
   reaching into internal classes — `panorama.asset.checked_out`,
   `panorama.reservation.approved`, etc.

Plugins run in-process in Community edition (simpler ops). Enterprise edition
may run them in a sidecar for stricter isolation (deferred).

## Alternatives considered

- **Webhooks only** — safe but too limited; partners can't render UI.
- **Embed a JS runtime (V8 isolates)** — too complex for v1.
- **Laravel-style service providers** — copy-paste from Snipe-IT's pattern.
  We're in Nest, so we use Nest's dynamic modules.

## Consequences

### Positive
- Partners / customers can extend without forking
- Clean lane for community-contributed integrations (Fleetio, Samsara, GeoTab)

### Negative
- We commit to maintaining plugin API stability; breaking changes need a
  deprecation cycle
- Security review for the capability model takes time

### Neutral
- Status stays Draft until the first plugin ships (probably a Teams
  connector in Community, since we already have FleetManager equivalent logic)
