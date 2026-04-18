import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import { ObjectStorageService } from './object-storage.service.js';

/**
 * ObjectStorageModule (ADR-0012 §3).
 *
 * Single-service module — imports AuditModule for the bootstrap
 * audit row, exports ObjectStorageService for consumers
 * (InspectionService, retention sweep). No top-level feature flag
 * here; InspectionModule gates its own consumption via
 * FEATURE_INSPECTIONS.
 */
@Module({
  imports: [ConfigModule, AuditModule],
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class ObjectStorageModule {}
