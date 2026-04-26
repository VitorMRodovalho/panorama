# ADR-0006: Plugin / extension SDK boundary

- Status: **Accepted** (narrow scope, 2026-04-26 — see "Scope at 0.3" below)
- Date: 2026-04-17 drafted; 2026-04-26 narrowed + accepted
- Deciders: Vitor Rodovalho
- Related: #84 (strip-back), ADR-0017 (AI/LLM integration principles —
  the isolation boundary required by Principle 2 is the same boundary
  any future plugin runtime must satisfy)

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

## Scope at 0.3 (the strip-back)

Per #84 (audit Wave-3a finding), the runtime portions of the original
draft are **deferred to 0.4+**. The 0.3 community surface is:

- `@panorama/plugin-sdk` exports **types only** —
  `PanoramaEventName`, `PanoramaEvent<T>`, `PluginContext`,
  `EventHandler<T>`. No runtime helpers (`onEvent`, `PluginModule.register`)
  are exposed. This locks the *contract* (payload shapes, event names)
  before any external author writes code against it, while keeping the
  attack surface zero until the isolation work lands.

- The well-known event catalog is the type union `PanoramaEventName`.
  Adding an event is a typed, type-checked change.

- `manifest.json` schema, plugin loader, capability model, UI extension
  slots, and the NestJS dynamic-module integration all move to a
  follow-up ADR alongside the isolation infrastructure required by
  ADR-0017 Principle 2 (worker thread with `--experimental-permission`,
  container, or Deno isolate — `vm.runInContext` is **not** an
  acceptable boundary).

- Why the strip-back: `PluginModule.register()` and `onEvent()` were
  loaded primitives with no isolation, no signature verification, and
  no allowlist gate. They predated ADR-0017 and would have given
  third-party code in-process credentials by import. Better to have
  no plugin runtime than a wrong one.

## Decision (0.4+ — deferred)

When the 0.4 plugin-runtime ADR lands it will specify:

1. A set of **typed hook interfaces** (TypeScript) mirroring NestJS lifecycle
   events and domain events. Plugins register providers via NestJS dynamic
   modules.
2. A **UI extension surface** exposed as Next.js slot components; plugins
   export React components that load into named slots (`dashboard.cards`,
   `settings.panels`, `asset.profile.tabs`).
3. A **manifest.json** per plugin declaring required permissions, required
   env vars, and the Panorama version range it's compatible with.
4. A **plugin loader** that runs plugin code under a real isolation
   boundary (worker thread with `--experimental-permission`, container,
   or Deno isolate — per ADR-0017 Principle 2). Capability model:
   read-only, write-own, write-all, invoke-webhook, all deny-by-default.
5. A signed-allowlist check for marketplace-sourced plugins (per
   ADR-0017 Principle 3).
6. The **well-known event catalog** at 0.3 (the `PanoramaEventName`
   union) is the seed; new events at 0.4 must be additions, not
   removals or renames, until a major version of the SDK.

Plugins were originally planned to run in-process in Community edition.
ADR-0017 retires that posture: in-process untrusted code is forbidden.
Community will run plugins under the same isolation boundary as
Enterprise; the only difference is the management UI.

## Alternatives considered

- **Webhooks only** — safe but too limited; partners can't render UI.
- **Embed a JS runtime (V8 isolates)** — too complex for v1;
  reconsidered for 0.4 in light of ADR-0017.
- **Laravel-style service providers** — copy-paste from Snipe-IT's pattern.
  We're in Nest, so we use Nest's dynamic modules.
- **Keep the original Draft runtime (`onEvent` + `PluginModule.register`)
  for 0.3.** Rejected — see Scope at 0.3 above; no isolation, no allowlist,
  no signature verification means any plugin import was an unaudited
  credential grant. ADR-0017 makes this posture unshippable.

## Consequences

### Positive

- Partners / customers can extend without forking (eventually — at 0.4)
- The event-type contract is locked early, so 0.4 plugins can be written
  against a stable type surface today
- Strip-back removes a credential-grant footgun before it has any callers
- ADR-0006 no longer contradicts ADR-0017 (the older draft did)

### Negative

- We commit to maintaining plugin API stability for the type contract;
  breaking changes to `PanoramaEventName` need a deprecation cycle even
  with no runtime
- 0.4 plugin-runtime work is now blocked on isolation infrastructure
  (acceptable — that infra is also required for any AI/LLM tool runtime
  per ADR-0017, so the work is shared)

### Neutral

- The `Status: Accepted (narrow scope)` framing is deliberate: future
  ADRs will cover the runtime, manifest, capability model, and UI slot
  layer as separate decisions. Each gets its own threat model.
