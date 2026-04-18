import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChannelRegistry } from './channel-registry.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationService } from './notification.service.js';

/**
 * Notification event bus (ADR-0011).
 *
 * Provides:
 *   * `NotificationService.enqueueWithin(tx, event)` — emit-side API
 *     for domain services. Mirrors AuditService.recordWithin.
 *   * `ChannelRegistry` — handler registration. Channels subscribe
 *     to eventType patterns at bootstrap.
 *   * `NotificationDispatcher` — outbox worker. Runs except in
 *     NODE_ENV=test or when FEATURE_NOTIFICATION_BUS=false.
 *
 * Subscribers (EmailChannel, WebhookChannel, SlackChannel, …) live
 * in their OWN modules and register with ChannelRegistry in the
 * consumer module's OnModuleInit. This module knows nothing about
 * individual channels.
 */
@Module({
  imports: [AuditModule],
  providers: [ChannelRegistry, NotificationDispatcher, NotificationService],
  exports: [ChannelRegistry, NotificationService],
})
export class NotificationModule {}
