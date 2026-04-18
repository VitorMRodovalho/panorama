import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { DiscoveryService } from './discovery.service.js';
import { OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';
import { getRequestSession } from './session.middleware.js';
import { AuthConfigService } from './auth.config.js';
import type { PanoramaSession } from './session.types.js';
import {
  ListPatSchema,
  MintPatSchema,
  RevokePatSchema,
} from './personal-access-token.dto.js';
import { PersonalAccessTokenService } from './personal-access-token.service.js';

const LoginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

const DiscoverySchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
});

const SwitchTenantSchema = z.object({
  tenantId: z.string().uuid(),
});

const OidcProviderSchema = z.enum(['google', 'microsoft']);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly discovery: DiscoveryService,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
    private readonly cfg: AuthConfigService,
    private readonly pats: PersonalAccessTokenService,
  ) {}

  @Get('me')
  async me(@Req() req: Request): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    return this.publicSessionShape(session);
  }

  @Get('discovery')
  async getDiscovery(@Query('email') email?: string): Promise<unknown> {
    const parsed = DiscoverySchema.safeParse({ email });
    if (!parsed.success) {
      // Never leak — respond with the baseline set as if the email were unknown.
      return { providers: ['password'], tenantHint: null };
    }
    return this.discovery.discover(parsed.data.email);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const { session, passwordNeedsRehash } = await this.auth.loginWithPassword(
      parsed.data.email,
      parsed.data.password,
    );

    if (passwordNeedsRehash) {
      // Opportunistic rehash on successful login — users benefit from
      // current Argon2 params without ever knowing.
      await this.auth.rehashPassword(parsed.data.email, parsed.data.password);
    }

    await this.sessions.setSession(req, res, session);
    return this.publicSessionShape(session);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.destroySession(req, res);
  }

  @Get('tenants')
  async listTenants(@Req() req: Request): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    return { memberships: session.memberships };
  }

  @Post('tenants/switch')
  @HttpCode(200)
  async switchTenant(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    const parsed = SwitchTenantSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const next = this.auth.switchTenant(session, parsed.data.tenantId);
    await this.sessions.setSession(req, res, next);
    return this.publicSessionShape(next);
  }

  // --- Personal Access Tokens (ADR-0010) ---------------------------
  //
  // All three endpoints require the session cookie — NEVER a PAT, so a
  // compromised PAT can't mint more PATs. The PatAuthGuard the step-5
  // SnipeitCompatModule installs lives in its own module and doesn't
  // reach /auth.

  @Get('tokens')
  async listTokens(
    @Query('scope') scope: string | undefined,
    @Query('includeRevoked') includeRevoked: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    const parsed = ListPatSchema.safeParse({ scope, includeRevoked, limit });
    if (!parsed.success) throw new BadRequestException('invalid_query');

    const rows = await this.pats.list({
      actor: {
        userId: session.userId,
        tenantId: session.currentTenantId,
        role: session.currentRole,
      },
      scope: parsed.data.scope,
      includeRevoked: parsed.data.includeRevoked,
      limit: parsed.data.limit,
    });
    return { items: rows.map((r) => this.pats.publicShape(r)) };
  }

  @Post('tokens')
  @HttpCode(201)
  async mintToken(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    const parsed = MintPatSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const result = await this.pats.mint({
      actor: {
        userId: session.userId,
        tenantId: session.currentTenantId,
      },
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      createdByIp: extractIp(req) ?? null,
      createdByUserAgent: req.headers['user-agent'] ?? null,
    });
    return {
      // Plaintext is returned exactly ONCE — never again. Response-shape
      // contract the docs + the FleetManager replay test both rely on.
      plaintext: result.plaintext,
      token: this.pats.publicShape(result.token),
    };
  }

  @Delete('tokens/:id')
  @HttpCode(200)
  async revokeToken(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException();
    const parsed = RevokePatSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid_body');
    const revokeParams: Parameters<PersonalAccessTokenService['revoke']>[0] = {
      actor: {
        userId: session.userId,
        tenantId: session.currentTenantId,
        role: session.currentRole,
      },
      tokenId: id,
    };
    if (parsed.data.reason) revokeParams.reason = parsed.data.reason;
    const row = await this.pats.revoke(revokeParams);
    return this.pats.publicShape(row);
  }

  // --- OIDC ---------------------------------------------------------

  @Get('oidc/:provider/start')
  async oidcStart(
    @Query('redirect') redirectParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const provider = this.requireProvider(req);
    const redirectTo = safeRedirect(redirectParam);
    const { url, state, codeVerifier, nonce } = await this.oidc.start({ provider, redirectTo });
    await this.sessions.setOauthState(req, res, {
      provider,
      state,
      codeVerifier,
      nonce,
      redirectTo,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    res.redirect(302, url);
  }

  @Get('oidc/:provider/callback')
  async oidcCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const provider = this.requireProvider(req);
    if (!code || !state) throw new BadRequestException('missing_code_or_state');

    const stored = await this.sessions.getOauthState(req, res);
    await this.sessions.destroyOauthState(req, res);
    if (!stored || stored.provider !== provider || stored.state !== state) {
      throw new UnauthorizedException('oidc_state_mismatch');
    }

    const userInfo = await this.oidc.callback({
      provider,
      code,
      state,
      expectedState: stored.state,
      codeVerifier: stored.codeVerifier,
      expectedNonce: stored.nonce,
    });

    const session = await this.auth.loginWithOidc({
      provider,
      subject: userInfo.subject,
      email: userInfo.email,
      firstName: userInfo.firstName,
      lastName: userInfo.lastName,
      displayName: userInfo.displayName,
    });
    await this.sessions.setSession(req, res, session);

    res.redirect(302, stored.redirectTo);
  }

  // --- helpers ------------------------------------------------------

  private requireProvider(req: Request): 'google' | 'microsoft' {
    const raw = (req.params as { provider?: string })?.provider ?? '';
    const parsed = OidcProviderSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('unknown_oidc_provider');
    if (!this.cfg.hasProvider(parsed.data)) {
      throw new BadRequestException(`oidc_provider_not_configured:${parsed.data}`);
    }
    return parsed.data;
  }

  private publicSessionShape(session: PanoramaSession): unknown {
    const { userId, email, displayName, currentTenantId, currentRole, isVip, memberships, provider } =
      session;
    return { userId, email, displayName, currentTenantId, currentRole, isVip, memberships, provider };
  }
}

/**
 * Accepts a redirect path and returns it only if it is a same-origin
 * absolute path. Anything else (protocol-relative, external URL) is
 * replaced with `/`. Prevents open-redirect abuse of our own endpoints.
 */
function safeRedirect(input: string | undefined): string {
  if (!input) return '/';
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  return '/';
}

/**
 * Best-effort client-IP extraction. Trusts the first X-Forwarded-For
 * hop if the app is running behind a proxy; otherwise falls back to
 * the raw socket. Result is stored verbatim on the PAT row — not used
 * for any authorisation decision.
 */
function extractIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? null;
}
