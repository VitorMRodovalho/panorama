import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/**
 * Thin AuditService over `audit_events`. Kept here instead of being
 * bolted onto each feature module so invitation / membership /
 * reservation paths all share the same hash-chaining logic.
 *
 * Global because almost every domain action wants to emit; requiring
 * per-module imports would turn this into boilerplate.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
