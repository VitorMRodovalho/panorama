import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEvent } from '@prisma/client';
import { MaintenanceTicketSubscriber } from '../src/modules/maintenance/maintenance-ticket.subscriber.js';
import type {
  AutoOpenResult,
  AutoOpenTicketParams,
  MaintenanceService,
} from '../src/modules/maintenance/maintenance.service.js';
import type { PrismaService } from '../src/modules/prisma/prisma.service.js';

/**
 * Unit coverage for the ADR-0016 §5 auto-suggest subscriber.
 *
 * Stubs PrismaService + MaintenanceService — the real wiring is exercised
 * by the maintenance-tether e2e suite, but those run only with the dev
 * stack up. This suite isolates the subscriber's branching: tenant-flag
 * gate, PASS short-circuit, payload extraction per event type, defensive
 * cross-tenant guard, missing-tenant defence-in-depth.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '33333333-3333-4333-8333-333333333333';
const STARTER_ID = '44444444-4444-4444-8444-444444444444';
const INSPECTION_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '66666666-6666-4666-8666-666666666666';
const SYSTEM_ACTOR_ID = '77777777-7777-4777-8777-777777777777';
const REQUESTER_ID = '88888888-8888-4888-8888-888888888888';
const CHECKED_IN_BY_ID = '99999999-9999-4999-8999-999999999999';

interface TenantFixture {
  autoOpenMaintenanceFromInspection: boolean;
  systemActorUserId: string;
}

interface PrismaFixture {
  tenant: TenantFixture | null;
  asset: { tag: string; tenantId: string } | null;
}

function makePrisma(fix: PrismaFixture): PrismaService {
  const tx = {
    tenant: { findUnique: vi.fn(async () => fix.tenant) },
    asset: { findUnique: vi.fn(async () => fix.asset) },
  };
  return {
    runInTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
}

interface MaintenanceFixture {
  result: AutoOpenResult;
}

function makeMaintenance(fix: MaintenanceFixture): MaintenanceService & {
  calls: AutoOpenTicketParams[];
} {
  const calls: AutoOpenTicketParams[] = [];
  const openTicketAuto = vi.fn(async (_tx: unknown, params: AutoOpenTicketParams) => {
    calls.push(params);
    return fix.result;
  });
  return Object.assign(
    { openTicketAuto } as unknown as MaintenanceService,
    { calls },
  );
}

function makeEvent(
  overrides: Partial<NotificationEvent> & { eventType: string; payload: object },
): NotificationEvent {
  const base = {
    id: 'evt-1',
    tenantId: TENANT_A,
    status: 'IN_PROGRESS',
    dispatchAttempts: 0,
    availableAt: new Date(),
    dispatchedAt: null,
    lastAttemptAt: new Date(),
    lastError: null,
    errorHistory: null,
    channelResults: null,
    dedupKey: null,
    createdAt: new Date('2026-04-26T15:00:00Z'),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides } as unknown as NotificationEvent;
}

const FAIL_INSPECTION_PAYLOAD = {
  inspectionId: INSPECTION_ID,
  assetId: ASSET_ID,
  reservationId: RESERVATION_ID,
  startedByUserId: STARTER_ID,
  outcome: 'FAIL' as const,
  photoCount: 3,
  responseCount: 12,
  summaryNote: 'brake light intermittent',
};

const DAMAGE_CHECKIN_PAYLOAD = {
  reservationId: RESERVATION_ID,
  assetId: ASSET_ID,
  requesterUserId: REQUESTER_ID,
  checkedInByUserId: CHECKED_IN_BY_ID,
  checkedInAt: '2026-04-26T15:00:00.000Z',
  mileageIn: 12_345,
  damageNote: 'cracked windshield, drivers side',
};

const FIXTURE_FLAG_ON: PrismaFixture = {
  tenant: { autoOpenMaintenanceFromInspection: true, systemActorUserId: SYSTEM_ACTOR_ID },
  asset: { tag: 'V-100', tenantId: TENANT_A },
};

const FIXTURE_FLAG_OFF: PrismaFixture = {
  tenant: { autoOpenMaintenanceFromInspection: false, systemActorUserId: SYSTEM_ACTOR_ID },
  asset: { tag: 'V-100', tenantId: TENANT_A },
};

const OPENED_RESULT: AutoOpenResult = { status: 'opened', ticketId: 'tkt-001' };

let prismaFixture: PrismaFixture;
let maintenance: ReturnType<typeof makeMaintenance>;
let subscriber: MaintenanceTicketSubscriber;

beforeEach(() => {
  prismaFixture = FIXTURE_FLAG_ON;
  maintenance = makeMaintenance({ result: OPENED_RESULT });
});

function build(): MaintenanceTicketSubscriber {
  return new MaintenanceTicketSubscriber(makePrisma(prismaFixture), maintenance);
}

describe('MaintenanceTicketSubscriber — supports()', () => {
  beforeEach(() => {
    subscriber = build();
  });

  it('matches the two ADR-0016 §5 trigger events', () => {
    expect(subscriber.supports('panorama.inspection.completed')).toBe(true);
    expect(subscriber.supports('panorama.reservation.checked_in_with_damage')).toBe(true);
  });

  it('does not match unrelated events', () => {
    expect(subscriber.supports('panorama.reservation.approved')).toBe(false);
    expect(subscriber.supports('panorama.maintenance.opened')).toBe(false);
    expect(subscriber.supports('panorama.reservation.checked_in')).toBe(false);
  });
});

describe('MaintenanceTicketSubscriber — tenant gate', () => {
  it('throws when event.tenantId is null (refuses runAsSuperAdmin)', async () => {
    subscriber = build();
    await expect(
      subscriber.handle(
        makeEvent({
          tenantId: null,
          eventType: 'panorama.inspection.completed',
          payload: FAIL_INSPECTION_PAYLOAD,
        }),
      ),
    ).rejects.toThrow(/missing_tenant_id/);
    expect(maintenance.calls).toEqual([]);
  });

  it('returns cleanly when tenant.autoOpenMaintenanceFromInspection is false', async () => {
    prismaFixture = FIXTURE_FLAG_OFF;
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: FAIL_INSPECTION_PAYLOAD,
      }),
    );
    expect(maintenance.calls).toEqual([]);
  });

  it('returns cleanly when the tenant row is missing (deleted-tenant residual)', async () => {
    prismaFixture = { tenant: null, asset: { tag: 'V-100', tenantId: TENANT_A } };
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: FAIL_INSPECTION_PAYLOAD,
      }),
    );
    expect(maintenance.calls).toEqual([]);
  });
});

describe('MaintenanceTicketSubscriber — inspection.completed', () => {
  it('opens a ticket for FAIL outcome with the right title + trigger fields', async () => {
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: FAIL_INSPECTION_PAYLOAD,
      }),
    );
    expect(maintenance.calls).toHaveLength(1);
    const params = maintenance.calls[0]!;
    expect(params.tenantId).toBe(TENANT_A);
    expect(params.assetId).toBe(ASSET_ID);
    expect(params.maintenanceType).toBe('Repair');
    expect(params.title).toBe('Inspection follow-up: V-100');
    expect(params.notes).toBe('brake light intermittent');
    expect(params.triggeringInspectionId).toBe(INSPECTION_ID);
    expect(params.triggeringReservationId).toBe(RESERVATION_ID);
    expect(params.createdByUserId).toBe(SYSTEM_ACTOR_ID);
    expect(params.originalActorUserId).toBe(STARTER_ID);
    expect(params.source).toBe('inspection_subscriber');
  });

  it('opens a ticket for NEEDS_MAINTENANCE outcome (parity with FAIL)', async () => {
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: { ...FAIL_INSPECTION_PAYLOAD, outcome: 'NEEDS_MAINTENANCE' },
      }),
    );
    expect(maintenance.calls).toHaveLength(1);
    expect(maintenance.calls[0]!.source).toBe('inspection_subscriber');
  });

  it('does NOT open a ticket for PASS outcome', async () => {
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: { ...FAIL_INSPECTION_PAYLOAD, outcome: 'PASS' },
      }),
    );
    expect(maintenance.calls).toEqual([]);
  });

  it('omits triggeringReservationId when payload reservationId is null (post-trip without reservation tether)', async () => {
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: { ...FAIL_INSPECTION_PAYLOAD, reservationId: null },
      }),
    );
    expect(maintenance.calls).toHaveLength(1);
    expect(maintenance.calls[0]!.triggeringReservationId).toBeUndefined();
  });

  it('passes null notes when summaryNote is missing', async () => {
    const noNotePayload = { ...FAIL_INSPECTION_PAYLOAD };
    delete (noNotePayload as { summaryNote?: string }).summaryNote;
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.inspection.completed',
        payload: noNotePayload,
      }),
    );
    expect(maintenance.calls[0]!.notes).toBeNull();
  });
});

describe('MaintenanceTicketSubscriber — checked_in_with_damage', () => {
  it('opens a ticket with the damage-path title + trigger fields', async () => {
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.reservation.checked_in_with_damage',
        payload: DAMAGE_CHECKIN_PAYLOAD,
      }),
    );
    expect(maintenance.calls).toHaveLength(1);
    const params = maintenance.calls[0]!;
    expect(params.tenantId).toBe(TENANT_A);
    expect(params.assetId).toBe(ASSET_ID);
    expect(params.maintenanceType).toBe('Repair');
    expect(params.title).toBe('Damage flagged at check-in: V-100');
    expect(params.notes).toBe('cracked windshield, drivers side');
    expect(params.triggeringReservationId).toBe(RESERVATION_ID);
    expect(params.triggeringInspectionId).toBeUndefined();
    expect(params.createdByUserId).toBe(SYSTEM_ACTOR_ID);
    expect(params.originalActorUserId).toBe(CHECKED_IN_BY_ID);
    expect(params.source).toBe('checkin_subscriber');
  });

  it('passes null notes when damageNote is missing', async () => {
    const noNotePayload = { ...DAMAGE_CHECKIN_PAYLOAD };
    delete (noNotePayload as { damageNote?: string }).damageNote;
    subscriber = build();
    await subscriber.handle(
      makeEvent({
        eventType: 'panorama.reservation.checked_in_with_damage',
        payload: noNotePayload,
      }),
    );
    expect(maintenance.calls[0]!.notes).toBeNull();
  });
});

describe('MaintenanceTicketSubscriber — defensive guards', () => {
  it('throws when the asset is missing (defensive)', async () => {
    prismaFixture = { ...FIXTURE_FLAG_ON, asset: null };
    subscriber = build();
    await expect(
      subscriber.handle(
        makeEvent({
          eventType: 'panorama.reservation.checked_in_with_damage',
          payload: DAMAGE_CHECKIN_PAYLOAD,
        }),
      ),
    ).rejects.toThrow(/asset_not_found/);
    expect(maintenance.calls).toEqual([]);
  });

  it('throws when the asset belongs to a different tenant (cross-tenant probe)', async () => {
    prismaFixture = {
      ...FIXTURE_FLAG_ON,
      asset: { tag: 'V-100', tenantId: TENANT_B },
    };
    subscriber = build();
    await expect(
      subscriber.handle(
        makeEvent({
          eventType: 'panorama.reservation.checked_in_with_damage',
          payload: DAMAGE_CHECKIN_PAYLOAD,
        }),
      ),
    ).rejects.toThrow(/asset_cross_tenant/);
    expect(maintenance.calls).toEqual([]);
  });

  it('returns the openTicketAuto skipped result without re-throwing (idempotent retry)', async () => {
    maintenance = makeMaintenance({
      result: { status: 'skipped', reason: 'existing_open_ticket', existingTicketId: 'tkt-001' },
    });
    subscriber = build();
    await expect(
      subscriber.handle(
        makeEvent({
          eventType: 'panorama.reservation.checked_in_with_damage',
          payload: DAMAGE_CHECKIN_PAYLOAD,
        }),
      ),
    ).resolves.toBeUndefined();
    // openTicketAuto was still called — the skip happens inside, not at
    // the subscriber boundary. The caller (dispatcher) sees success and
    // marks the event dispatched, which is the desired retry-idempotent
    // contract.
    expect(maintenance.calls).toHaveLength(1);
  });
});
