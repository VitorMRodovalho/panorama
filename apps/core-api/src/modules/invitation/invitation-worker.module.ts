import { Module } from '@nestjs/common';
import { InvitationModule } from './invitation.module.js';
import { INVITATION_QUEUE } from './invitation.queue.js';
import { BullMqInvitationQueue } from './invitation-email.queue.js';

/**
 * Opt-in module that swaps the no-op InvitationQueuePort for the
 * BullMQ-backed implementation. Registered at AppModule so the worker
 * spins up at process start alongside the HTTP server.
 *
 * Tests import `InvitationModule` alone (which leaves the no-op in
 * place) so they don't need Redis; the production app bundles this
 * module too.
 */
@Module({
  imports: [InvitationModule],
  providers: [
    BullMqInvitationQueue,
    { provide: INVITATION_QUEUE, useExisting: BullMqInvitationQueue },
  ],
  exports: [INVITATION_QUEUE, BullMqInvitationQueue],
})
export class InvitationWorkerModule {}
