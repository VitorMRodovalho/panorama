import { Injectable, Logger } from '@nestjs/common';
import type { NotificationEvent } from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChannelHandler } from './channel-registry.js';
import { renderReservationDecisionEmail } from './reservation-email.templates.js';

/**
 * Email channel for reservation decisions (ADR-0011 step 6).
 *
 * Listens for:
 *   * panorama.reservation.approved
 *   * panorama.reservation.rejected
 *
 * The payload carries only IDs (see NOTIFICATION_PAYLOAD_SCHEMAS).
 * The handler fetches tenant + user + asset details inside the
 * dispatcher's runInTenant(event.tenantId) context, so every Prisma
 * lookup lands under that tenant's RLS. A compromised handler can't
 * read tenant B's rows while processing tenant A's event.
 *
 * Logging: the handler's logger strips the `event.payload` key — we
 * log `eventId`, `eventType`, `recipient`, `channel="email"` only,
 * per the ADR's handler-log-hygiene rule.
 */
@Injectable()
export class ReservationEmailChannel implements ChannelHandler {
  readonly name = 'email';
  private readonly log = new Logger('ReservationEmailChannel');

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  supports(eventType: string): boolean {
    return (
      eventType === 'panorama.reservation.approved' ||
      eventType === 'panorama.reservation.rejected'
    );
  }

  async handle(event: NotificationEvent): Promise<void> {
    if (!event.tenantId) {
      // reservation.* events MUST carry a tenantId. If we get one
      // without, something wrote a bad row — refuse instead of
      // silently running under super-admin.
      throw new Error('missing_tenant_id');
    }
    const payload = event.payload as {
      reservationId: string;
      assetId: string | null;
      requesterUserId: string;
      approverUserId: string;
      startAt: string;
      endAt: string;
      note?: string;
    };

    // All lookups go through runInTenant so the RLS policy applies
    // — the dispatcher's outer runInTenant wraps the invocation but
    // does NOT propagate the tenant GUC into top-level Prisma calls
    // (GUC is tx-local). We open our own tx for the reads, close it,
    // then run the SMTP send outside so a slow network doesn't hold
    // the row lock.
    const data = await this.prisma.runInTenant(event.tenantId, async (tx) => {
      const [tenant, requester, approver, asset] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: event.tenantId! },
          select: { displayName: true, locale: true },
        }),
        tx.user.findUnique({
          where: { id: payload.requesterUserId },
          select: { email: true, displayName: true },
        }),
        tx.user.findUnique({
          where: { id: payload.approverUserId },
          select: { displayName: true },
        }),
        payload.assetId
          ? tx.asset.findUnique({
              where: { id: payload.assetId },
              select: { tag: true, name: true, tenantId: true },
            })
          : Promise.resolve(null),
      ]);
      return { tenant, requester, approver, asset };
    });
    const { tenant, requester, approver, asset } = data;
    if (!tenant || !requester) {
      throw new Error('tenant_or_requester_missing');
    }
    // Defence: the findUnique on asset by id doesn't filter by
    // tenantId. Verify.
    if (asset && asset.tenantId !== event.tenantId) {
      throw new Error('asset_cross_tenant');
    }

    const baseUrl = process.env['PANORAMA_WEB_BASE_URL'] ?? 'http://localhost:3000';
    const reservationUrl = `${baseUrl.replace(/\/+$/, '')}/reservations/${payload.reservationId}`;

    const decision =
      event.eventType === 'panorama.reservation.approved' ? 'approved' : 'rejected';

    const rendered = renderReservationDecisionEmail({
      locale: (tenant.locale ?? 'en') as 'en' | 'pt-br' | 'es',
      decision,
      recipientEmail: requester.email,
      recipientName: requester.displayName,
      tenantDisplayName: tenant.displayName,
      approverName: approver?.displayName ?? 'An admin',
      assetLabel: asset ? `${asset.tag} — ${asset.name}` : null,
      startAt: new Date(payload.startAt),
      endAt: new Date(payload.endAt),
      note: payload.note ?? null,
      reservationUrl,
    });

    await this.email.send({
      to: requester.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    this.log.log(
      {
        eventId: event.id,
        eventType: event.eventType,
        recipient: requester.email,
        channel: this.name,
      },
      'reservation_email_sent',
    );
  }
}
