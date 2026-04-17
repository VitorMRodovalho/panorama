/**
 * Public plugin SDK surface.
 * Stable contract: breaking changes follow a deprecation cycle per
 * semantic versioning of @panorama/plugin-sdk.
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

export function onEvent<T = unknown>(
  name: PanoramaEventName,
  handler: EventHandler<T>,
): { __panorama_handler: true; name: PanoramaEventName; handler: EventHandler<T> } {
  return { __panorama_handler: true, name, handler };
}

// Re-exported by plugin authors in their server.ts:
export const PluginModule = {
  register<T>(cls: T): { provide: 'PANORAMA_PLUGIN_MODULE'; useValue: T } {
    return { provide: 'PANORAMA_PLUGIN_MODULE', useValue: cls };
  },
};
