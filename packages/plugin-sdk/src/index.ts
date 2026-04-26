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

export type PanoramaEventName =
  | 'panorama.asset.checked_out'
  | 'panorama.asset.checked_in'
  | 'panorama.reservation.created'
  | 'panorama.reservation.approved'
  | 'panorama.reservation.rejected'
  | 'panorama.reservation.missed'
  | 'panorama.maintenance.flagged';

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
