/**
 * Maintenance module — MVP slice of ADR-0016.
 *
 * Forbid-list invariant (ADR-0016 §1.4 + §7.2): the entire maintenance
 * module writes via `runInTenant(tenantId, …)` only — `runAsSuperAdmin`
 * is not used here, and the #58 allowlist gate enforces it across CI.
 *
 * Loaded conditionally at app boot when `FEATURE_MAINTENANCE` is on
 * (default false — see app.module.ts). Mirrors the FEATURE_INSPECTIONS
 * gating pattern so a community deploy with maintenance off doesn't
 * register the routes.
 */
import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';

// PrismaModule + AuditModule are @Global so no explicit import needed.
@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
