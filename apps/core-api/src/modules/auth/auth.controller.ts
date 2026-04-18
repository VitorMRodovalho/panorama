import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
