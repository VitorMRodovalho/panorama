import { Module } from '@nestjs/common';

/**
 * TenantModule is kept as a container for future tenant-specific providers
 * (catalogue filters, per-tenant settings cache). As of 0.2, all tenant
 * context work lives in AuthModule's SessionMiddleware — the old
 * X-Tenant-Id header path has been removed for security (allowed bypass
 * by forging a header; session cookie is authenticated + encrypted).
 */
@Module({})
export class TenantModule {}
