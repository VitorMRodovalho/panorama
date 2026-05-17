import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { ObjectStorageModule } from '../object-storage/object-storage.module.js';
import { TenantExportConfigService } from './tenant-export.config.js';
import { TenantExportController } from './tenant-export.controller.js';
import { TenantExportService } from './tenant-export.service.js';
import { TenantExportQueue } from './tenant-export.queue.js';

/**
 * ADR-0020 §8 — tenant-data export surface (PR 4).
 *
 * Loaded UNCONDITIONALLY. The endpoint is Owner-only + per-tenant
 * rate-limited; tenants that never request an export pay zero cost.
 * ObjectStorageModule moved out of the inspections conditional in
 * the same PR (it's a generic S3 wrapper now used by both inspection
 * photos and tenant exports).
 *
 * The BullMQ queue idle-in-tests so e2e tests drive `runJob`
 * directly. Production deployments run the worker continuously.
 */
@Module({
  imports: [EmailModule, ObjectStorageModule],
  controllers: [TenantExportController],
  providers: [TenantExportConfigService, TenantExportService, TenantExportQueue],
  exports: [TenantExportService],
})
export class TenantExportModule {}
