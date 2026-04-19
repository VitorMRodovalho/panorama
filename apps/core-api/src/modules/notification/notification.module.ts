import { Module, OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EmailModule } from '../email/email.module.js';
import { ChannelRegistry } from './channel-registry.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationService } from './notification.service.js';
import { ReservationEmailChannel } from './email-channel.js';
import { InspectionOutcomeEmailChannel } from './inspection-outcome-email-channel.js';

/**
 * Notification event bus (ADR-0011).
 *
 * Provides:
 *   * `NotificationService.enqueueWithin(tx, event)` — emit-side API
 *     for domain services. Mirrors AuditService.recordWithin.
 *   * `ChannelRegistry` — handler registration.
 *   * `NotificationDispatcher` — outbox worker. Runs except in
 *     NODE_ENV=test or when FEATURE_NOTIFICATION_BUS=false.
 *
 * First-party subscribers register during this module's OnModuleInit.
 * The InspectionOutcomeEmailChannel is registered unconditionally — the
 * inspection feature is gated upstream (FEATURE_INSPECTIONS), so when
 * the flag is off no `panorama.inspection.completed` events are
 * published and the handler stays inert.
 */
@Module({
  imports: [AuditModule, EmailModule],
  providers: [
    ChannelRegistry,
    NotificationDispatcher,
    NotificationService,
    ReservationEmailChannel,
    InspectionOutcomeEmailChannel,
  ],
  exports: [ChannelRegistry, NotificationService],
})
export class NotificationModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly reservationEmail: ReservationEmailChannel,
    private readonly inspectionOutcomeEmail: InspectionOutcomeEmailChannel,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.reservationEmail);
    this.registry.register(this.inspectionOutcomeEmail);
  }
}
