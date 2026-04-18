import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { PatAuthGuard } from './pat-auth.guard.js';
import { ScopeGuard } from './scope.guard.js';
import { SnipeitCompatController } from './snipeit-compat.controller.js';
import { SnipeitCompatService } from './snipeit-compat.service.js';

/**
 * Snipe-IT compat shim (ADR-0010).
 *
 * Separate Nest module so PAT auth stays a hard boundary: native
 * modules do not import `PatAuthGuard`, so they cannot be reached
 * with a PAT. `SessionMiddleware` suppresses the session entirely
 * when a PAT Bearer header is present, closing the "silent
 * fallback" failure mode at the other side.
 *
 * Registration is gated by `FEATURE_SNIPEIT_COMPAT_SHIM`
 * (default enabled, `false` to disable). `AppModule` consults the
 * env var at bootstrap and omits the import if the shim is turned
 * off — the endpoints simply don't exist at runtime.
 */
@Module({
  imports: [AuditModule, AuthModule, RedisModule],
  controllers: [SnipeitCompatController],
  providers: [PatAuthGuard, ScopeGuard, SnipeitCompatService],
})
export class SnipeitCompatModule {}
