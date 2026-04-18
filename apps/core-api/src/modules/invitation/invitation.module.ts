import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InvitationConfigService } from './invitation.config.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';
import { INVITATION_QUEUE, NoopInvitationQueue } from './invitation.queue.js';

/**
 * Wires the invitation flow (ADR-0008).
 *
 * The queue implementation is pluggable via the INVITATION_QUEUE token.
 * Default here is the no-op implementation so unit tests + dev boots
 * without Redis still work. The BullMQ-backed implementation lives in
 * `invitation-email.module.ts` (next commit) and re-binds the token
 * via `{ provide: INVITATION_QUEUE, useExisting: BullMqInvitationQueue }`
 * when wired in AppModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [InvitationController],
  providers: [
    InvitationConfigService,
    InvitationService,
    NoopInvitationQueue,
    { provide: INVITATION_QUEUE, useExisting: NoopInvitationQueue },
  ],
  exports: [InvitationService, InvitationConfigService, INVITATION_QUEUE],
})
export class InvitationModule {}
