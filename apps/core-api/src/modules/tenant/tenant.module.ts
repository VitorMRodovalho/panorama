import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenantAdminController, TenantOwnershipController } from './tenant-admin.controller.js';
import { TenantAdminService } from './tenant-admin.service.js';

/**
 * Tenant-scoped providers. As of 0.2 step 3d this owns the admin
 * surface for membership role + status transitions (promote / demote /
 * suspend), enforcing ADR-0007's "≥1 active Owner" invariant with
 * friendly error messages on top of the DB-side trigger, plus a
 * member-visible ownership-summary endpoint that powers the
 * single-Owner warning banner in the web app.
 *
 * Request context (currentTenant, currentUser) still lives in
 * AuthModule's SessionMiddleware.
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [TenantAdminController, TenantOwnershipController],
  providers: [TenantAdminService],
  exports: [TenantAdminService],
})
export class TenantModule {}
