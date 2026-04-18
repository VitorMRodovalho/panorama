import { Injectable, Logger } from '@nestjs/common';

/**
 * Abstract seam between InvitationService and whatever queues the
 * actual email delivery job. Implementation lives in
 * `invitation-email.queue.ts` (BullMQ) so the service can be tested
 * without Redis / BullMQ running — tests drop in a no-op stub.
 *
 * `enqueueDelivery` is fire-and-forget from the caller's perspective:
 * the invitation row already has `emailQueuedAt` set inside the DB
 * transaction, so a lost enqueue gets rescued by the sweep cron.
 */
export interface InvitationQueuePort {
  enqueueDelivery(invitationId: string): Promise<void>;
}

export const INVITATION_QUEUE = Symbol('INVITATION_QUEUE');

/**
 * Default no-op implementation used when the BullMQ worker isn't
 * wired (tests, cli tooling). Logs so a forgotten wiring doesn't go
 * silent in production.
 */
@Injectable()
export class NoopInvitationQueue implements InvitationQueuePort {
  private readonly log = new Logger('NoopInvitationQueue');

  async enqueueDelivery(invitationId: string): Promise<void> {
    this.log.debug({ invitationId }, 'noop_enqueue');
  }
}
