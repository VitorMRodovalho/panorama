import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BootAuditService } from './boot-audit.service.js';

/**
 * Boot-time audits per ADR-0015 §4. Single-service module imported
 * from `app.module.ts` LAST in the imports array so its
 * `OnModuleInit` fires after Prisma + Audit + Redis have all wired
 * up. Skipped in NODE_ENV=test (the service self-skips).
 *
 * AuditModule is `@Global` so doesn't need an explicit import here;
 * RedisModule is also `@Global`. PrismaModule is already a hard dep
 * of AuditModule. The constructor's PrismaService injection is the
 * dependency-graph signal that makes Nest wait until Prisma is
 * connected before instantiating us.
 *
 * AuthModule is imported explicitly (not @Global) so we can inject
 * AuthConfigService — needed to check the SESSION_SECRET rotation
 * state when emitting the `panorama.auth.session_secret_rotated`
 * row (#234). AuthConfigService is in AuthModule's `exports` list.
 */
@Module({
  imports: [AuthModule],
  providers: [BootAuditService],
})
export class BootAuditModule {}
