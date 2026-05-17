import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { SignupConfigService } from './signup.config.js';
import { SignupController } from './signup.controller.js';
import { SignupStateStore } from './signup-state.store.js';
import { SignupRateLimits } from './signup-rate-limits.service.js';
import { TurnstileVerifier } from './turnstile-verifier.service.js';

/**
 * Self-serve OIDC signup endpoints (ADR-0020). Loaded conditionally
 * at app boot when `FEATURE_SELF_SERVE_SIGNUP=true` (gated in
 * `app.module.ts`). Default off so a self-hoster who upgrades
 * Panorama doesn't accidentally open a public signup surface; the
 * hosted instance flips the flag.
 *
 * Imports:
 *   - AuthModule (forwardRef) — needs `OidcService`,
 *     `AuthService.resolveOidcUserForSignup`, `SessionService`,
 *     `AuthConfigService` for the OIDC dance.
 *   - TenantModule — needs `TenantAdminService.createTenantWithOwner`
 *     to provision the new tenant atomically with the Owner
 *     membership + audit row.
 *   - RedisModule + AuditModule are @Global so they ride in
 *     automatically.
 */
@Module({
  imports: [forwardRef(() => AuthModule), TenantModule],
  controllers: [SignupController],
  providers: [SignupConfigService, SignupStateStore, SignupRateLimits, TurnstileVerifier],
})
export class SignupModule {}
