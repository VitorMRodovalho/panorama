import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { AuthConfigService } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CsrfOriginMiddleware } from './csrf-origin.middleware.js';
import { DiscoveryService } from './discovery.service.js';
import { OidcService } from './oidc.service.js';
import { PasswordService } from './password.service.js';
import { PatMembershipCache } from './pat-membership-cache.service.js';
import { PersonalAccessTokenService } from './personal-access-token.service.js';
import { SessionMiddleware } from './session.middleware.js';
import { SessionService } from './session.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { RedisModule } from '../redis/redis.module.js';

/**
 * AuthModule — the 0.2 cut.
 *
 * Provides:
 *   * Email+password login with argon2id hashing
 *   * Iron-session encrypted cookies (HttpOnly, SameSite=Lax)
 *   * Google + Microsoft OIDC with PKCE and nonce validation
 *   * Home-Realm Discovery by email domain
 *   * Multi-tenant session with tenant switching
 *   * SessionMiddleware that populates the AsyncLocalStorage context for
 *     PrismaService / RLS isolation — replaces the 0.1 header-based stub
 *
 * Lands in 0.3 and beyond:
 *   * Invitation acceptance flow (the data model is already in place)
 *   * SAML, WebAuthn, TOTP
 *   * Enterprise IdP connectors (Okta, Ping, JumpCloud SCIM push)
 *   * Policy-as-code authorisation (CASL is imported but not yet wired)
 */
@Module({
  imports: [AuditModule, RedisModule],
  controllers: [AuthController],
  providers: [
    AuthConfigService,
    AuthService,
    CsrfOriginMiddleware,
    DiscoveryService,
    OidcService,
    PasswordService,
    PatMembershipCache,
    PersonalAccessTokenService,
    SessionService,
    SessionMiddleware,
  ],
  exports: [
    AuthConfigService,
    AuthService,
    PasswordService,
    PatMembershipCache,
    PersonalAccessTokenService,
    SessionService,
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // CSRF Origin/Referer gate runs FIRST: a cross-origin POST gets
    // rejected before we touch the session, the DB, or anything else.
    // SEC-02 / #34 — pairs with the SameSite=Lax cookie set in
    // session.service.ts. Documented in SECURITY.md §Hardening.
    consumer
      .apply(CsrfOriginMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
    // Every request runs through the session middleware so downstream
    // code never sees a request without a resolved tenant context.
    // `{ path: '*', method: RequestMethod.ALL }` is the ESM-safe form —
    // the bare-string `forRoutes('*')` short-circuits under Node's ESM
    // resolver and leaves controller routes unregistered.
    consumer
      .apply(SessionMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
