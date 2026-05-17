import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { TenantDeletionConfigService } from './tenant-deletion.config.js';
import { TenantDeletionController } from './tenant-deletion.controller.js';
import { TenantDeletionService } from './tenant-deletion.service.js';
import { TenantDeletionSweepService } from './tenant-deletion-sweep.service.js';

/**
 * ADR-0020 §7 — tenant deletion cool-off surface.
 *
 * Loaded UNCONDITIONALLY. The endpoints are Owner-only and the
 * cron sweep is idle-in-tests; both behave as no-ops on a self-host
 * that never has any tenant request deletion. The benefit of
 * always-on: any tenant created (whether self-hosted, seeded, or
 * via the self-serve signup) has the deletion path available
 * without needing a separate feature flag.
 */
@Module({
  imports: [EmailModule],
  controllers: [TenantDeletionController],
  providers: [
    TenantDeletionConfigService,
    TenantDeletionService,
    TenantDeletionSweepService,
  ],
  exports: [TenantDeletionService],
})
export class TenantDeletionModule {}
