import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEvent } from '@prisma/client';
import { InspectionOutcomeEmailChannel } from '../src/modules/notification/inspection-outcome-email-channel.js';
import type { EmailService } from '../src/modules/email/email.service.js';
import type { PrismaService } from '../src/modules/prisma/prisma.service.js';

/**
 * Unit coverage for ADR-0012 §11 first-party subscriber.
 *
 * Stubs PrismaService + EmailService — the real wiring is exercised
 * by the notification-bus integration test, but those run only when
 * an inspection actually completes (Execution-order step 7+). This
 * suite isolates the channel's branching: PASS short-circuit,
 * FAIL/NEEDS_MAINTENANCE fan-out, recipient filter, defensive
 * cross-tenant guard.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '33333333-3333-4333-8333-333333333333';
const STARTER_ID = '44444444-4444-4444-8444-444444444444';
const INSPECTION_ID = '55555555-5555-4555-8555-555555555555';

interface Recipient {
  email: string;
  displayName: string;
  role: string;
  status: string;
}

interface PrismaFixture {
  tenant: { displayName: string; locale: string } | null;
  asset: { tag: string; name: string; tenantId: string } | null;
  starter: { displayName: string; email: string } | null;
  recipients: Recipient[];
}

function makePrisma(fix: PrismaFixture): PrismaService {
  const tx = {
    tenant: {
      findUnique: vi.fn(async () => fix.tenant),
    },
    asset: {
      findUnique: vi.fn(async () => fix.asset),
    },
    user: {
      findUnique: vi.fn(async () => fix.starter),
    },
    tenantMembership: {
      findMany: vi.fn(async () =>
        fix.recipients
          .filter((r) => r.status === 'active' && (r.role === 'owner' || r.role === 'fleet_admin'))
          .map((r) => ({
            userId: r.email,
            user: { email: r.email, displayName: r.displayName },
          })),
      ),
    },
  };
  return {
    runInTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
}

function makeEmail(): EmailService & { sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = [];
  const send = vi.fn(async (msg: { to: string; subject: string; text: string; html: string }) => {
    sent.push({ to: msg.to, subject: msg.subject });
  });
  return Object.assign({ send }, { sent }) as unknown as EmailService & {
    sent: Array<{ to: string; subject: string }>;
  };
}

function makeEvent(overrides: Partial<NotificationEvent> & { payload: object }): NotificationEvent {
  const base = {
    id: 'evt-1',
    tenantId: TENANT_A,
    eventType: 'panorama.inspection.completed',
    status: 'IN_PROGRESS',
    dispatchAttempts: 0,
    availableAt: new Date(),
    dispatchedAt: null,
    lastAttemptAt: new Date(),
    lastError: null,
    errorHistory: null,
    channelResults: null,
    dedupKey: null,
    createdAt: new Date('2026-04-18T15:00:00Z'),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides } as unknown as NotificationEvent;
}

const FAIL_PAYLOAD = {
  inspectionId: INSPECTION_ID,
  assetId: ASSET_ID,
  reservationId: null,
  startedByUserId: STARTER_ID,
  outcome: 'FAIL',
  photoCount: 3,
  responseCount: 12,
  summaryNote: 'brake light intermittent',
};

const ACTIVE_OWNER: Recipient = {
  email: 'owner@fleet.test',
  displayName: 'Olivia Owner',
  role: 'owner',
  status: 'active',
};
const ACTIVE_ADMIN: Recipient = {
  email: 'admin@fleet.test',
  displayName: 'Adam Admin',
  role: 'fleet_admin',
  status: 'active',
};
const SUSPENDED_ADMIN: Recipient = {
  email: 'gone@fleet.test',
  displayName: 'Gone Admin',
  role: 'fleet_admin',
  status: 'suspended',
};
const DRIVER: Recipient = {
  email: 'drv@fleet.test',
  displayName: 'Dee Driver',
  role: 'driver',
  status: 'active',
};

const FIXTURE_BASE: PrismaFixture = {
  tenant: { displayName: 'Acme Fleet', locale: 'en' },
  asset: { tag: 'V-100', name: 'Tractor 100', tenantId: TENANT_A },
  starter: { displayName: 'Drew Driver', email: 'drv@fleet.test' },
  recipients: [ACTIVE_OWNER, ACTIVE_ADMIN, SUSPENDED_ADMIN, DRIVER],
};

let email: ReturnType<typeof makeEmail>;
let channel: InspectionOutcomeEmailChannel;

beforeEach(() => {
  email = makeEmail();
});

describe('InspectionOutcomeEmailChannel — supports()', () => {
  it('matches only panorama.inspection.completed', () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    expect(channel.supports('panorama.inspection.completed')).toBe(true);
    expect(channel.supports('panorama.reservation.approved')).toBe(false);
    expect(channel.supports('panorama.inspection.started')).toBe(false);
  });
});

describe('InspectionOutcomeEmailChannel — PASS outcome', () => {
  it('does NOT send any email for PASS', async () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    const event = makeEvent({ payload: { ...FAIL_PAYLOAD, outcome: 'PASS' } });
    await channel.handle(event);
    expect(email.sent).toEqual([]);
  });
});

describe('InspectionOutcomeEmailChannel — FAIL outcome fan-out', () => {
  it('emails active owner + fleet_admin (2 recipients) for FAIL', async () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    await channel.handle(makeEvent({ payload: FAIL_PAYLOAD }));
    const tos = email.sent.map((s) => s.to).sort();
    expect(tos).toEqual(['admin@fleet.test', 'owner@fleet.test']);
    // The driver's email is not in the recipient list even though
    // they're also a member of the tenant.
    expect(email.sent.find((s) => s.to === 'drv@fleet.test')).toBeUndefined();
    // Nor the suspended admin.
    expect(email.sent.find((s) => s.to === 'gone@fleet.test')).toBeUndefined();
  });

  it('subject indicates the FAIL outcome and asset label', async () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    await channel.handle(makeEvent({ payload: FAIL_PAYLOAD }));
    expect(email.sent[0]?.subject).toMatch(/FAIL/);
    expect(email.sent[0]?.subject).toMatch(/V-100/);
  });
});

describe('InspectionOutcomeEmailChannel — NEEDS_MAINTENANCE outcome', () => {
  it('also fans out (parity with FAIL)', async () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    await channel.handle(
      makeEvent({ payload: { ...FAIL_PAYLOAD, outcome: 'NEEDS_MAINTENANCE' } }),
    );
    expect(email.sent.length).toBe(2);
    expect(email.sent[0]?.subject).toMatch(/maintenance/i);
  });
});

describe('InspectionOutcomeEmailChannel — defensive guards', () => {
  it('throws when event.tenantId is null (refuses runAsSuperAdmin)', async () => {
    channel = new InspectionOutcomeEmailChannel(makePrisma(FIXTURE_BASE), email);
    await expect(
      channel.handle(makeEvent({ tenantId: null, payload: FAIL_PAYLOAD })),
    ).rejects.toThrow(/missing_tenant_id/);
  });

  it('throws when the asset belongs to a different tenant', async () => {
    const fix: PrismaFixture = {
      ...FIXTURE_BASE,
      asset: { tag: 'V-100', name: 'Tractor 100', tenantId: TENANT_B },
    };
    channel = new InspectionOutcomeEmailChannel(makePrisma(fix), email);
    await expect(channel.handle(makeEvent({ payload: FAIL_PAYLOAD }))).rejects.toThrow(
      /asset_cross_tenant/,
    );
    expect(email.sent).toEqual([]);
  });

  it('throws when tenant / asset / starter is missing', async () => {
    const fix: PrismaFixture = { ...FIXTURE_BASE, tenant: null };
    channel = new InspectionOutcomeEmailChannel(makePrisma(fix), email);
    await expect(channel.handle(makeEvent({ payload: FAIL_PAYLOAD }))).rejects.toThrow(
      /tenant_asset_or_starter_missing/,
    );
  });

  it('returns cleanly (no throw) when there are no admin recipients', async () => {
    const fix: PrismaFixture = { ...FIXTURE_BASE, recipients: [DRIVER] };
    channel = new InspectionOutcomeEmailChannel(makePrisma(fix), email);
    await channel.handle(makeEvent({ payload: FAIL_PAYLOAD }));
    expect(email.sent).toEqual([]);
  });

  it('aggregates partial SMTP failures and re-throws', async () => {
    const failingEmail = makeEmail();
    failingEmail.send = vi.fn(async (msg: { to: string; subject: string; text: string; html: string }) => {
      if (msg.to === 'owner@fleet.test') throw new Error('smtp_550');
      failingEmail.sent.push({ to: msg.to, subject: msg.subject });
    }) as unknown as EmailService['send'];
    channel = new InspectionOutcomeEmailChannel(
      makePrisma(FIXTURE_BASE),
      failingEmail as unknown as EmailService,
    );
    await expect(channel.handle(makeEvent({ payload: FAIL_PAYLOAD }))).rejects.toThrow(
      /email_send_partial_failure/,
    );
    // The admin still got their copy — one bad SMTP target should not
    // block siblings on the same event.
    expect(failingEmail.sent.map((s) => s.to)).toEqual(['admin@fleet.test']);
  });
});
