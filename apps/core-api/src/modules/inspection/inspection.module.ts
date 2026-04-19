import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { InspectionTemplateService } from './inspection-template.service.js';
import { InspectionTemplateController } from './inspection-template.controller.js';

/**
 * InspectionModule (ADR-0012 §Execution-order step 7+).
 *
 * 0.3 surface — landing in three sub-steps:
 *   * 7a (this commit) — InspectionTemplate CRUD.
 *   * 7b — InspectionService lifecycle (start/respond/complete/...).
 *   * 7c — InspectionPhoto upload + GET redirect.
 *
 * Loaded conditionally with ObjectStorageModule + PhotoPipelineModule
 * when `FEATURE_INSPECTIONS=true` (gated in `app.module.ts`).
 *
 * Architectural forbid: this module CANNOT call `runAsSuperAdmin`.
 * The only allowed escape is `AuditService.record` (which already
 * does it correctly outside this module). Grep gate enforces in 0.3;
 * an ESLint custom rule lands at 0.4. See the head comment of
 * `inspection-template.service.ts` for the full invariant.
 */
@Module({
  imports: [AuditModule],
  controllers: [InspectionTemplateController],
  providers: [InspectionTemplateService],
  exports: [InspectionTemplateService],
})
export class InspectionModule {}
