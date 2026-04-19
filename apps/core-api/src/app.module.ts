import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './modules/prisma/prisma.module.js';
import { TenantModule } from './modules/tenant/tenant.module.js';
import { AssetModule } from './modules/asset/asset.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ImportModule } from './modules/import/import.module.js';
import { RedisModule } from './modules/redis/redis.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { EmailModule } from './modules/email/email.module.js';
import { InvitationModule } from './modules/invitation/invitation.module.js';
import { InvitationWorkerModule } from './modules/invitation/invitation-worker.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { ObjectStorageModule } from './modules/object-storage/object-storage.module.js';
import { PhotoPipelineModule } from './modules/photo-pipeline/photo-pipeline.module.js';
import { InspectionModule } from './modules/inspection/inspection.module.js';
import { ReservationModule } from './modules/reservation/reservation.module.js';
import { SnipeitCompatModule } from './modules/snipeit-compat/snipeit-compat.module.js';
import { BootAuditModule } from './modules/boot-audit/boot-audit.module.js';

/**
 * `FEATURE_SNIPEIT_COMPAT_SHIM` (ADR-0010 rollback plan) toggles
 * registration of the SnipeitCompatModule at boot. Default on;
 * setting the env var to "false" / "0" / "no" drops the entire
 * /api/v1 surface without a migration rollback. The flag is read
 * once at bootstrap — changes require a redeploy, matching the
 * feature-flag semantics the ADR commits to.
 */
function snipeitShimEnabled(): boolean {
  const raw = (process.env['FEATURE_SNIPEIT_COMPAT_SHIM'] ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

const conditionalCompatShim: DynamicModule[] = snipeitShimEnabled()
  ? [{ module: SnipeitCompatModule, global: false }]
  : [];

/**
 * `FEATURE_INSPECTIONS` (ADR-0012 §12) gates InspectionModule — and
 * for 0.3 the ObjectStorageModule too, since the latter exists only
 * to back inspection photos. First-release default is `false`; flip
 * per-tenant on canary; community default flips to `true` after two
 * stable patch releases. Same shape as FEATURE_SNIPEIT_COMPAT_SHIM.
 */
function inspectionsEnabled(): boolean {
  const raw = (process.env['FEATURE_INSPECTIONS'] ?? 'false').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

const conditionalInspections: DynamicModule[] = inspectionsEnabled()
  ? [
      { module: ObjectStorageModule, global: false },
      { module: PhotoPipelineModule, global: false },
      { module: InspectionModule, global: false },
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      { name: 'global', ttl: 60_000, limit: 120 },
      { name: 'auth', ttl: 60_000, limit: 10 },
    ]),
    PrismaModule,
    TenantModule,
    RedisModule,
    AuditModule,
    EmailModule,
    AuthModule,
    NotificationModule,
    InvitationModule,
    InvitationWorkerModule,
    ReservationModule,
    AssetModule,
    HealthModule,
    ImportModule,
    ...conditionalCompatShim,
    ...conditionalInspections,
    // BootAuditModule LAST — its OnModuleInit fires after Prisma +
    // Audit + Redis are wired so the boot audits commit cleanly.
    BootAuditModule,
    // 0.2: PluginHostModule, I18nModule.forRootAsync.
  ],
})
export class AppModule {}
