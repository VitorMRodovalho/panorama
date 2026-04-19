import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { ObjectStorageModule } from '../object-storage/object-storage.module.js';
import { PhotoPipelineModule } from '../photo-pipeline/photo-pipeline.module.js';
import { InspectionTemplateService } from './inspection-template.service.js';
import { InspectionTemplateController } from './inspection-template.controller.js';
import { InspectionService } from './inspection.service.js';
import { InspectionController } from './inspection.controller.js';
import { InspectionPhotoService } from './inspection-photo.service.js';
import { InspectionPhotoController } from './inspection-photo.controller.js';
import { InspectionMaintenanceService } from './inspection-maintenance.service.js';

/**
 * InspectionModule (ADR-0012 §Execution-order step 7+).
 *
 * 0.3 surface — landing in three sub-steps:
 *   * 7a — InspectionTemplate CRUD.
 *   * 7b (this commit) — InspectionService lifecycle.
 *   * 7c — InspectionPhoto upload + GET redirect.
 *
 * Loaded conditionally with ObjectStorageModule + PhotoPipelineModule
 * when `FEATURE_INSPECTIONS=true` (gated in `app.module.ts`).
 *
 * Architectural forbid: this module CANNOT call `runAsSuperAdmin`.
 * The only allowed escape is `AuditService.record` (which already
 * does it correctly outside this module). Grep gate enforces in 0.3;
 * an ESLint custom rule lands at 0.4. See the head comments of
 * `inspection-template.service.ts` and `inspection.service.ts` for
 * the full invariant.
 */
@Module({
  imports: [AuditModule, NotificationModule, ObjectStorageModule, PhotoPipelineModule],
  controllers: [
    InspectionTemplateController,
    InspectionController,
    InspectionPhotoController,
  ],
  providers: [
    InspectionTemplateService,
    InspectionService,
    InspectionPhotoService,
    InspectionMaintenanceService,
  ],
  exports: [
    InspectionTemplateService,
    InspectionService,
    InspectionPhotoService,
    InspectionMaintenanceService,
  ],
})
export class InspectionModule {}
