import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { PANORAMA_EVENT_NAMES } from '@panorama/plugin-sdk';
import { NOTIFICATION_PAYLOAD_SCHEMAS } from '../src/modules/notification/notification-events.schema.js';

/**
 * Sync gate (#59 follow-up). The plugin SDK's
 * `PanoramaEventName` / `PANORAMA_EVENT_NAMES` is the public-facing
 * list of events plugins can subscribe to. The notification bus's
 * `NOTIFICATION_PAYLOAD_SCHEMAS` is the runtime registry —
 * unregistered events are rejected at enqueue time, so any name in
 * the SDK's list that isn't in the schemas is a guaranteed
 * plugin-author footgun (the typecheck is happy but the event
 * never fires).
 *
 * Pre-#59 the SDK shipped 7 entries; only 2 were wired through the
 * bus. This test fails loud if a future contributor adds an event
 * to one surface without adding it to the other.
 */
describe('notification event registry — plugin-sdk ↔ bus sync (#59)', () => {
  it('every PanoramaEventName has a registered Zod schema', () => {
    const registered = new Set(Object.keys(NOTIFICATION_PAYLOAD_SCHEMAS));
    const sdkNames = [...PANORAMA_EVENT_NAMES];
    const orphans = sdkNames.filter((n) => !registered.has(n));
    expect(orphans).toEqual([]);
  });

  it('every registered schema has a PanoramaEventName entry', () => {
    const sdkSet = new Set<string>(PANORAMA_EVENT_NAMES);
    const registered = Object.keys(NOTIFICATION_PAYLOAD_SCHEMAS);
    const ghosts = registered.filter((n) => !sdkSet.has(n));
    expect(ghosts).toEqual([]);
  });
});
