import { Module, OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EmailModule } from '../email/email.module.js';
import { ChannelRegistry } from './channel-registry.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationService } from './notification.service.js';
import { ReservationEmailChannel } from './email-channel.js';

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
 * First-party subscribers (ReservationEmailChannel at 0.3) register
 * during this module's OnModuleInit. Future channels can either land
 * here (for core handlers) or in their own module that imports
 * NotificationModule and calls `registry.register(...)` in their own
 * bootstrap hook.
 */
@Module({
  imports: [AuditModule, EmailModule],
  providers: [
    ChannelRegistry,
    NotificationDispatcher,
    NotificationService,
    ReservationEmailChannel,
  ],
  exports: [ChannelRegistry, NotificationService],
})
export class NotificationModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly reservationEmail: ReservationEmailChannel,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.reservationEmail);
  }
}
