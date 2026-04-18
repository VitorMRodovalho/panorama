import { Module } from '@nestjs/common';
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
    InvitationModule,
    AssetModule,
    HealthModule,
    ImportModule,
    // 0.2: ReservationModule, NotificationModule, PluginHostModule,
    //      I18nModule.forRootAsync.
  ],
})
export class AppModule {}
