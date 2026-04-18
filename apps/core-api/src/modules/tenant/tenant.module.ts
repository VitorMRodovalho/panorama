import { Module } from '@nestjs/common';
import { TenantAdminController } from './tenant-admin.controller.js';
import { TenantAdminService } from './tenant-admin.service.js';

/**
 * Tenant-scoped providers. As of 0.2 step 3d this owns the admin
 * surface for membership role + status transitions (promote / demote /
 * suspend), enforcing ADR-0007's "≥1 active Owner" invariant with
 * friendly error messages on top of the DB-side trigger.
 *
 * Request context (currentTenant, currentUser) still lives in
 * AuthModule's SessionMiddleware.
 */
@Module({
  controllers: [TenantAdminController],
  providers: [TenantAdminService],
  exports: [TenantAdminService],
})
export class TenantModule {}
