/**
 * Public plugin SDK surface — types only at 0.3.
 *
 * Per ADR-0006 (Accepted 2026-04-26, narrow scope per #84): this package
 * exposes the plugin event-type contract only. The runtime loader, NestJS
 * dynamic-module helper, and React UI-slot surface are deferred to 0.4+
 * and will land alongside the isolation boundary required by ADR-0017.
 *
 * Stable contract: breaking changes to the exported types follow a
 * deprecation cycle per semantic versioning of @panorama/plugin-sdk.
 */

/**
 * Events plugins can subscribe to. **MUST stay in sync** with
 * `NOTIFICATION_PAYLOAD_SCHEMAS` in
 * `apps/core-api/src/modules/notification/notification-events.schema.ts`
 * — the runtime registry is the source of truth for which events are
 * actually deliverable through the bus.
 *
 * Drift between this list and the registry is a guaranteed plugin-author
 * footgun: authors get a happy typecheck for an event that will never
 * fire. The CI check at
 * `apps/core-api/test/notification-bus.integration.test.ts`
 * (#59 sync test) asserts the two lists match.
 *
 * Pre-#59 this list had 4 ghost events (`asset.checked_out`,
 * `asset.checked_in`, `reservation.missed`, `maintenance.flagged`) +
 * 1 audit-only event (`reservation.created`) that never entered the
 * bus. Plugin authors who keyed on those would never see them fire.
 */
/**
 * Runtime enumeration of plugin-subscribable events. Tests + tooling
 * iterate this; the type alias below is `(typeof PANORAMA_EVENT_NAMES)[number]`
 * so the two surfaces can't drift.
 */
export const PANORAMA_EVENT_NAMES = [
  'panorama.reservation.approved',
  'panorama.reservation.rejected',
  'panorama.reservation.checked_in_with_damage',
  'panorama.inspection.completed',
] as const;

export type PanoramaEventName = (typeof PANORAMA_EVENT_NAMES)[number];

export interface PanoramaEvent<T = unknown> {
  name: PanoramaEventName;
  occurredAt: string; // ISO timestamp
  tenantId: string;
  payload: T;
  context: {
    actorUserId: string | null;
    correlationId: string;
  };
}

export interface PluginContext {
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  http: {
    post(url: string, body: unknown, init?: RequestInit): Promise<Response>;
    get(url: string, init?: RequestInit): Promise<Response>;
  };
  config: {
    get<T = unknown>(key: string): T | undefined;
  };
  tenantId: string;
}

export type EventHandler<T = unknown> = (
  ctx: PluginContext,
  evt: PanoramaEvent<T>,
) => Promise<void> | void;
