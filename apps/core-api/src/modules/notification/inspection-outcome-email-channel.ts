import { Injectable, Logger } from '@nestjs/common';
import type { NotificationEvent } from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChannelHandler } from './channel-registry.js';
import {
  type InspectionEmailOutcome,
  renderInspectionOutcomeEmail,
} from './inspection-email.templates.js';
import type { SupportedLocale } from './reservation-email.templates.js';

/**
 * Email channel for inspection outcomes (ADR-0012 §11) — first-party
 * subscriber for `panorama.inspection.completed`.
 *
 * Filtering rule:
 *   * outcome = PASS  → no email sent (handler still completes; the
 *     event is persisted + audited regardless, so future subscribers
 *     can opt-in to PASS later without a schema change).
 *   * outcome = FAIL | NEEDS_MAINTENANCE → fans out one email per
 *     active `owner` / `fleet_admin` membership in the tenant.
 *
 * persona-fleet-ops blocker that sets the 0.3 vs 0.4 line: a driver
 * completing a FAIL pre-trip and ops only finding out on the next
 * dashboard refresh is a safety gap. Push-notify ops via email closes
 * the loop. SMS / in-app push come in 0.4.
 *
 * Tenant isolation: every Prisma read happens inside an explicit
 * `runInTenant(event.tenantId)` so the dispatcher's outer GUC scope
 * (which is tx-local) doesn't decide the contract — same defensive
 * pattern as `ReservationEmailChannel`.
 */
@Injectable()
export class InspectionOutcomeEmailChannel implements ChannelHandler {
  // Distinct from ReservationEmailChannel.name='email' — ChannelRegistry
  // requires unique handler names so channelResults stays unambiguous
  // when two email-class handlers ran for the same event-class log line.
  readonly name = 'inspection-outcome-email';
  private readonly log = new Logger('InspectionOutcomeEmailChannel');

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  supports(eventType: string): boolean {
    return eventType === 'panorama.inspection.completed';
  }

  async handle(event: NotificationEvent): Promise<void> {
    if (!event.tenantId) {
      // inspection.* events MUST be tenant-scoped — refuse rather
      // than fall through to runAsSuperAdmin and read the wrong row.
      throw new Error('missing_tenant_id');
    }
    const payload = event.payload as {
      inspectionId: string;
      assetId: string;
      reservationId: string | null;
      startedByUserId: string;
      outcome: 'PASS' | 'FAIL' | 'NEEDS_MAINTENANCE';
      photoCount: number;
      responseCount: number;
      summaryNote?: string;
    };

    if (payload.outcome === 'PASS') {
      // No email for PASS — keep the handler successful so the event
      // marks DISPATCHED on first attempt instead of accumulating
      // failed retries.
      this.log.log(
        { eventId: event.id, eventType: event.eventType, outcome: 'PASS' },
        'inspection_outcome_email_skipped_pass',
      );
      return;
    }
    const outcome: InspectionEmailOutcome = payload.outcome;

    const data = await this.prisma.runInTenant(event.tenantId, async (tx) => {
      const [tenant, asset, starter, recipients] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: event.tenantId! },
          select: { displayName: true, locale: true },
        }),
        tx.asset.findUnique({
          where: { id: payload.assetId },
          select: { tag: true, name: true, tenantId: true },
        }),
        tx.user.findUnique({
          where: { id: payload.startedByUserId },
          select: { displayName: true, email: true },
        }),
        tx.tenantMembership.findMany({
          where: {
            tenantId: event.tenantId!,
            status: 'active',
            role: { in: ['owner', 'fleet_admin'] },
          },
          select: {
            userId: true,
            user: { select: { email: true, displayName: true } },
          },
        }),
      ]);
      return { tenant, asset, starter, recipients };
    });

    const { tenant, asset, starter, recipients } = data;
    if (!tenant || !asset || !starter) {
      throw new Error('tenant_asset_or_starter_missing');
    }
    // Defence: findUnique on asset doesn't filter by tenantId. Guard
    // against the (should-be-impossible) cross-tenant assetId.
    if (asset.tenantId !== event.tenantId) {
      throw new Error('asset_cross_tenant');
    }

    if (recipients.length === 0) {
      // No admins to notify — log and exit cleanly. Treating this as
      // an error would dead-letter the event for an org-config issue
      // outside this handler's control. The audit row from the
      // dispatcher will still record `dispatched`.
      this.log.warn(
        {
          eventId: event.id,
          eventType: event.eventType,
          tenantId: event.tenantId,
          outcome,
        },
        'inspection_outcome_email_no_recipients',
      );
      return;
    }

    const baseUrl = process.env['PANORAMA_WEB_BASE_URL'] ?? 'http://localhost:3000';
    const baseUrlNorm = baseUrl.replace(/\/+$/, '');
    const inspectionUrl = `${baseUrlNorm}/inspections/${payload.inspectionId}`;
    const reservationUrl = payload.reservationId
      ? `${baseUrlNorm}/reservations/${payload.reservationId}`
      : null;

    const assetLabel = `${asset.tag} — ${asset.name}`;
    const starterName = starter.displayName || starter.email;
    // The notification row is enqueued in the same tx as the
    // inspection completion (`enqueueWithin`), so `createdAt` is a
    // tight proxy for the actual completion moment. Avoiding a
    // dedicated payload field keeps the schema lean.
    const completedAt = event.createdAt;
    const sendErrors: Array<{ to: string; error: string }> = [];

    const locale = pickLocale(tenant.locale);
    for (const r of recipients) {
      if (!r.user?.email) continue;
      const rendered = renderInspectionOutcomeEmail({
        locale,
        outcome,
        recipientEmail: r.user.email,
        recipientName: r.user.displayName || r.user.email,
        tenantDisplayName: tenant.displayName,
        starterName,
        assetLabel,
        completedAt,
        photoCount: payload.photoCount,
        responseCount: payload.responseCount,
        summaryNote: payload.summaryNote ?? null,
        inspectionUrl,
        reservationUrl,
      });
      try {
        await this.email.send({
          to: r.user.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
        this.log.log(
          {
            eventId: event.id,
            eventType: event.eventType,
            recipient: r.user.email,
            channel: this.name,
            outcome,
          },
          'inspection_outcome_email_sent',
        );
      } catch (err) {
        // One bad recipient SMTP shouldn't block the rest. Collect
        // and re-throw at end so the dispatcher's per-channel result
        // shows the failure, but other admins still receive their
        // copies before the retry kicks in.
        sendErrors.push({ to: r.user.email, error: String(err) });
      }
    }

    if (sendErrors.length > 0) {
      throw new Error(
        `email_send_partial_failure:${sendErrors.length}/${recipients.length}`,
      );
    }
  }
}

function pickLocale(raw: string | null): SupportedLocale {
  const l = (raw ?? 'en').toLowerCase();
  if (l.startsWith('pt')) return 'pt-br';
  if (l.startsWith('es')) return 'es';
  return 'en';
}
