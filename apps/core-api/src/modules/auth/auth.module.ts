import { Module } from '@nestjs/common';

/**
 * Auth module — scaffolded but empty at 0.1.
 *
 * 0.2 brings:
 *   - Email/password registration + login with argon2id hashing
 *   - Iron-session encrypted cookies (per-tenant secret)
 *   - Google OIDC + Microsoft OIDC providers wired through `openid-client`
 *   - SessionMiddleware that replaces TenantMiddleware's temporary
 *     X-Tenant-Id / X-User-Id header path
 *
 * 0.3 brings:
 *   - SAML via a verified node-saml version
 *   - WebAuthn passkeys via `@simplewebauthn/server`
 *   - 2FA TOTP
 *
 * Enterprise edition brings:
 *   - Okta advanced, PingFederate, JumpCloud SCIM push
 *   - FIDO2 AAL-2 attestation
 *   - Policy-as-code authorisation via Rego
 */
@Module({})
export class AuthModule {}
