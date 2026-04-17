# @panorama/plugin-sdk

Typed hooks and lifecycle interfaces for extending Panorama without forking the core.
See [ADR-0006](../../docs/adr/0006-plugin-sdk.md) for the boundary and why we
chose NestJS dynamic modules + Next.js slot components as the extension surface.

Status: **Draft**. The first stable surface ships with v0.4.

## Shape

Plugin manifest:

```json
{
  "name": "@acme/panorama-fleetio",
  "displayName": "Fleetio sync",
  "version": "0.1.0",
  "compatibleWith": ">=0.4.0 <2.0.0",
  "permissions": ["read:asset", "write:asset", "webhook:outbound"],
  "entrypoints": {
    "server": "dist/server.js",
    "client": "dist/client.js"
  },
  "events": ["panorama.asset.checked_out", "panorama.asset.checked_in"]
}
```

Server entrypoint exports a NestJS dynamic module:

```ts
import { Module } from '@nestjs/common';
import { PluginModule, onEvent } from '@panorama/plugin-sdk';

@Module({
  providers: [
    onEvent('panorama.asset.checked_out', async (ctx, evt) => {
      await ctx.http.post('https://api.fleetio.com/...', evt.payload);
    }),
  ],
})
export class FleetioPlugin {}

export default PluginModule.register(FleetioPlugin);
```

Client entrypoint exports named React components:

```tsx
export const dashboardCards = [{
  id: 'fleetio-sync-status',
  title: 'Fleetio sync',
  component: () => <div>...</div>,
}];
```

Plugins are loaded at boot from `plugins/*/manifest.json` (self-hosted) or
installed via `panorama plugins install @acme/panorama-fleetio`.

## Security

- Plugins run **in-process** in Community; a capability system limits which
  SDK methods they can call based on their declared permissions.
- Enterprise edition can run plugins in a sidecar process via `vm2`
  contexts (deferred).

## Contributing

Plugin contributions are welcome in a separate `panorama-plugins` repo (to be
created when the first external plugin ships). Reference implementations live
under `examples/`.
