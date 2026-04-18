import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { AuthConfigService } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DiscoveryService } from './discovery.service.js';
import { OidcService } from './oidc.service.js';
import { PasswordService } from './password.service.js';
import { SessionMiddleware } from './session.middleware.js';
import { SessionService } from './session.service.js';

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
  controllers: [AuthController],
  providers: [
    AuthConfigService,
    AuthService,
    DiscoveryService,
    OidcService,
    PasswordService,
    SessionService,
    SessionMiddleware,
  ],
  exports: [AuthConfigService, AuthService, PasswordService, SessionService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
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
