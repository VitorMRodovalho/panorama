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
 *
 * Plaintext token travels in the payload. Only `sha256(token)` is
 * persisted in the DB (ADR-0008); the worker needs the plaintext to
 * inline it into the accept URL that goes into the email. The
 * attack surface — plaintext visible to anyone with Redis read
 * access — is the same trust zone as the app itself, and the job
 * is removed from Redis on completion (see `removeOnComplete`).
 */
export interface InvitationQueuePort {
  /**
   * Queue an invitation email for delivery. `tenantId` rides in the
   * payload so the worker can run callbacks under `runInTenant` instead
   * of escalating to `runAsSuperAdmin` (#115 / closes a #56 follow-up).
   */
  enqueueDelivery(
    invitationId: string,
    tenantId: string,
    plaintextToken: string,
  ): Promise<void>;
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

  async enqueueDelivery(
    invitationId: string,
    tenantId: string,
    _plaintextToken: string,
  ): Promise<void> {
    this.log.debug({ invitationId, tenantId }, 'noop_enqueue');
  }
}
