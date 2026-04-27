import { Injectable, Logger } from '@nestjs/common';
import type { NotificationEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChannelHandler } from '../notification/channel-registry.js';
import { AuditService } from '../audit/audit.service.js';
import { MaintenanceService, type AutoOpenTicketParams } from './maintenance.service.js';

/**
 * MaintenanceTicketSubscriber — auto-suggest draft tickets from upstream
 * domain signals (ADR-0016 §5).
 *
 * Subscribes to two events:
 *
 *   1. `panorama.reservation.checked_in_with_damage` — emitted by
 *      ReservationService.checkIn when `damageFlag === true`. Closes the
 *      dominant ~70% trigger path per persona-fleet-ops (driver returns
 *      vehicle with damage → ticket auto-opens for ops).
 *
 *   2. `panorama.inspection.completed` with outcome IN ('FAIL',
 *      'NEEDS_MAINTENANCE'). Closes the ADR-0012 §11 dead-end where
 *      a FAIL inspection emits an email but never a ticket.
 *
 * Per-tenant gate: writes a ticket only when
 * `tenant.autoOpenMaintenanceFromInspection = true` (default false).
 * The flag default is conservative on purpose — flag-flip on a tenant
 * with a backlog of historical FAIL signals would otherwise flood the
 * dashboard. Pilot tenants opt in after their signal:noise calibration.
 *
 * --- Architectural note (ADR-0016 §5 v2 deviation) ---
 *
 * ADR-0016 §5 v2 sketched a new `DomainEventSubscriber` primitive that
 * runs *inside the publisher's transaction*, coupling failure fates so
 * a subscriber bug rolls the publisher back. v1's stated concern was
 * "ChannelHandler silently drops the ticket creation on 40001."
 *
 * The current dispatcher does NOT silently drop — handler failures get
 * retried with exponential backoff up to MAX_ATTEMPTS=5, then DEAD with
 * an audit row. So the silent-drop concern is unfounded against the
 * code as it stands.
 *
 * Coupled fate is also undesirable for this specific surface: a buggy
 * MaintenanceTicketSubscriber would otherwise refuse driver check-ins
 * (a primary user-facing flow) on every replay attempt. The outbox
 * pattern keeps the user-facing flow committing successfully and
 * surfaces subscriber failures via the dispatcher's retry/DEAD audit
 * trail — operationally equivalent without the user-visible blast.
 *
 * Idempotency for the decoupled path lives in
 * `MaintenanceService.openTicketAuto`: at most one OPEN/IN_PROGRESS
 * ticket per asset, audited skip on duplicate.
 *
 * Tenant isolation: every Prisma read happens inside an explicit
 * `runInTenant(event.tenantId)` so the dispatcher's outer GUC scope
 * (tx-local) does not decide the contract — same defensive pattern
 * as `InspectionOutcomeEmailChannel`. `runAsSuperAdmin` is **forbidden**
 * in MaintenanceModule per ADR-0016 §1.4 / §7.2 + the #58 allowlist.
 *
 * XSS surface: `payload.summaryNote` and `payload.damageNote` are
 * passed through to `params.notes` raw — the escape happens at write
 * inside `MaintenanceService.openTicketAuto` via `escapeHtml(params.notes)`,
 * matching the public `openTicket` path. Single chokepoint per ADR-0016
 * security-reviewer blocker #3.
 */
@Injectable()
export class MaintenanceTicketSubscriber implements ChannelHandler {
  // Distinct name from other handlers — the registry rejects duplicates.
  readonly name = 'maintenance-ticket';
  private readonly log = new Logger('MaintenanceTicketSubscriber');

  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
  ) {}

  supports(eventType: string): boolean {
    return (
      eventType === 'panorama.reservation.checked_in_with_damage' ||
      eventType === 'panorama.inspection.completed'
    );
  }

  async handle(event: NotificationEvent): Promise<void> {
    if (!event.tenantId) {
      // Auto-suggest is strictly tenant-scoped — refuse rather than fall
      // through to runAsSuperAdmin and write under the wrong tenant.
      // Audit the failure before the throw so a flag-flip backfill or
      // a forensic walkthrough has an immediate trail; the dispatcher's
      // retry path will still fire and eventually DEAD-letter after
      // MAX_ATTEMPTS=5 (~31 min backoff) — this audit just doesn't
      // make ops wait for it.
      await this.recordFailureAudit(event, 'missing_tenant_id', null);
      throw new Error('missing_tenant_id');
    }
    const tenantId = event.tenantId;

    // Set inside `runInTenant` and consumed AFTER it returns. The
    // flag-off audit cannot be written from within the tenant tx
    // (audit_events writes need super-admin); lifting it out keeps
    // the privilege boundary clean.
    let flagOff = false;

    try {
      await this.prisma.runInTenant(tenantId, async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            autoOpenMaintenanceFromInspection: true,
            systemActorUserId: true,
          },
        });
        if (!tenant) {
          // Stale event for a deleted tenant. Throwing would loop the
          // dispatcher's retry path. Return cleanly so the row marks
          // dispatched and the issue (deleted-tenant residual events)
          // surfaces via the cleanup audit trail elsewhere.
          this.log.warn(
            { eventId: event.id, eventType: event.eventType, tenantId },
            'auto_suggest_tenant_missing',
          );
          return;
        }
        if (!tenant.autoOpenMaintenanceFromInspection) {
          // Per-tenant opt-in — log + return cleanly so the event marks
          // dispatched on first attempt instead of accumulating retries.
          flagOff = true;
          this.log.log(
            { eventId: event.id, eventType: event.eventType, tenantId },
            'auto_suggest_skipped_flag_off',
          );
          return;
        }

        const params = await this.buildParams(tx, event, tenant.systemActorUserId);
        if (!params) {
          // PASS outcome on inspection.completed → no ticket. The event
          // itself still dispatches successfully.
          return;
        }

        const result = await this.maintenance.openTicketAuto(tx, params);
        this.log.log(
          {
            eventId: event.id,
            eventType: event.eventType,
            tenantId,
            source: params.source,
            result: result.status,
            ...(result.status === 'opened'
              ? { ticketId: result.ticketId }
              : { reason: result.reason, existingTicketId: result.existingTicketId }),
          },
          'auto_suggest_processed',
        );
      });
    } catch (err) {
      // The runInTenant tx has already rolled back at this point, so
      // an audit row written here lands cleanly outside it. Don't
      // mask the original error if the audit itself fails — re-throw
      // either way so the dispatcher's retry/DEAD-letter path stays
      // authoritative.
      const reason = err instanceof Error ? err.message : 'unknown';
      await this.recordFailureAudit(event, reason, extractAssetId(event));
      throw err;
    }

    if (flagOff) {
      // Backfill-recoverable trail: when a tenant flips the flag from
      // false → true, ops needs to know which events were dropped on
      // the floor so they can decide whether to replay or accept the
      // gap. The dispatcher already marks the event dispatched
      // successfully; this is the second leg.
      await this.audit.record({
        action: 'panorama.maintenance.auto_suggest_skipped',
        resourceType: 'notification_event',
        resourceId: event.id,
        tenantId,
        actorUserId: null,
        metadata: {
          eventType: event.eventType,
          reason: 'flag_off',
          assetId: extractAssetId(event),
        },
      });
    }
  }

  private async recordFailureAudit(
    event: NotificationEvent,
    reason: string,
    assetId: string | null,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: 'panorama.maintenance.auto_suggest_failed',
        resourceType: assetId ? 'asset' : 'notification_event',
        resourceId: assetId ?? event.id,
        tenantId: event.tenantId ?? null,
        actorUserId: null,
        metadata: {
          eventType: event.eventType,
          eventId: event.id,
          reason,
        },
      });
    } catch (auditErr) {
      // If audit itself fails, log + continue. The dispatcher's
      // eventual DEAD-letter audit (MAX_ATTEMPTS=5) is the
      // backstop; this is the soft trail.
      this.log.error(
        {
          err: String(auditErr),
          originalReason: reason,
          eventId: event.id,
          tenantId: event.tenantId,
        },
        'auto_suggest_audit_failed',
      );
    }
  }

  /**
   * Translate the bus event into the `openTicketAuto` shape. Returns
   * null when the event is a no-op (PASS outcome on inspection).
   *
   * Asset.tag is read here so the title carries a human-readable
   * vehicle identifier — same convention as the inspection-outcome
   * email subject. A null `asset` here means **schema corruption**
   * (assetId in the event payload no longer references a row): under
   * `runInTenant(event.tenantId)`, RLS already filters out cross-
   * tenant rows so the assetId-belongs-to-other-tenant case lands as
   * null, indistinguishable from "row was deleted." The explicit
   * `asset_cross_tenant` check below remains as belt-and-braces
   * against an RLS-misconfiguration regression — under healthy RLS
   * it is dead code.
   *
   * The interpolated `asset.tag` is NOT HTML-escaped. Title is
   * plain-text-by-contract: REST consumers render via JSX (auto-
   * escape) and the column carries the literal tag string. Notes
   * by contrast carry user-typed multi-line content and ARE escaped
   * at write inside `MaintenanceService.openTicketAuto`. The
   * asymmetry is intentional — single chokepoint per
   * security-reviewer blocker #3.
   */
  private async buildParams(
    tx: Prisma.TransactionClient,
    event: NotificationEvent,
    systemActorUserId: string,
  ): Promise<AutoOpenTicketParams | null> {
    if (event.eventType === 'panorama.inspection.completed') {
      const payload = event.payload as {
        inspectionId: string;
        assetId: string;
        reservationId: string | null;
        startedByUserId: string;
        outcome: 'PASS' | 'FAIL' | 'NEEDS_MAINTENANCE';
        summaryNote?: string;
      };
      if (payload.outcome === 'PASS') {
        this.log.log(
          { eventId: event.id, outcome: 'PASS' },
          'auto_suggest_skipped_pass_outcome',
        );
        return null;
      }
      const asset = await tx.asset.findUnique({
        where: { id: payload.assetId },
        select: { tag: true, tenantId: true },
      });
      if (!asset) throw new Error('asset_not_found');
      if (asset.tenantId !== event.tenantId) throw new Error('asset_cross_tenant');
      // persona-fleet-ops: prefix the title with the outcome so a
      // coordinator scanning the maintenance dashboard can triage FAIL
      // (vehicle won't pull out) vs NEEDS-MAINT (deferrable) at a
      // glance — three characters of difference, big triage value.
      const outcomeTag = payload.outcome === 'FAIL' ? 'FAIL' : 'NEEDS-MAINT';
      const params: AutoOpenTicketParams = {
        tenantId: event.tenantId,
        assetId: payload.assetId,
        maintenanceType: 'Repair',
        title: `Inspection ${outcomeTag}: ${asset.tag}`,
        notes: payload.summaryNote ?? null,
        triggeringInspectionId: payload.inspectionId,
        createdByUserId: systemActorUserId,
        originalActorUserId: payload.startedByUserId,
        source: 'inspection_subscriber',
      };
      if (payload.reservationId) params.triggeringReservationId = payload.reservationId;
      return params;
    }

    if (event.eventType === 'panorama.reservation.checked_in_with_damage') {
      const payload = event.payload as {
        reservationId: string;
        assetId: string;
        requesterUserId: string;
        checkedInByUserId: string;
        checkedInAt: string;
        mileageIn: number;
        damageNote?: string;
      };
      const asset = await tx.asset.findUnique({
        where: { id: payload.assetId },
        select: { tag: true, tenantId: true },
      });
      if (!asset) throw new Error('asset_not_found');
      if (asset.tenantId !== event.tenantId) throw new Error('asset_cross_tenant');
      return {
        tenantId: event.tenantId,
        assetId: payload.assetId,
        maintenanceType: 'Repair',
        title: `Damage flagged at check-in: ${asset.tag}`,
        notes: payload.damageNote ?? null,
        triggeringReservationId: payload.reservationId,
        createdByUserId: systemActorUserId,
        originalActorUserId: payload.checkedInByUserId,
        source: 'checkin_subscriber',
      };
    }

    // supports() should have filtered these out, but defence-in-depth.
    throw new Error(`unsupported_event_type:${event.eventType}`);
  }
}

/**
 * Pull `assetId` out of the event payload when present. Both supported
 * event types carry it; an unrecognised event type returns null and
 * the audit row falls back to `notification_event` resource scope.
 */
function extractAssetId(event: NotificationEvent): string | null {
  if (
    event.eventType !== 'panorama.inspection.completed' &&
    event.eventType !== 'panorama.reservation.checked_in_with_damage'
  ) {
    return null;
  }
  const payload = event.payload as { assetId?: string } | null;
  return payload?.assetId ?? null;
}
