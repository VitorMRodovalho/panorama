import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PatAuthGuard } from './pat-auth.guard.js';
import { RequireScope, ScopeGuard } from './scope.guard.js';

const SCOPE_READ = 'snipeit.compat.read';

/**
 * Snipe-IT compatibility shim controllers.
 *
 * Mounted at `/api/v1` — every route authenticates via
 * `Authorization: Bearer pnrm_pat_<...>` (ADR-0010). Session cookies
 * are ignored here; the `PatAuthGuard` rejects them at the boundary.
 *
 * The `whoami` route is a diagnostic — it lets a FleetManager
 * operator validate their token + prefix + tenant binding without
 * consulting the DB directly. Other routes (hardware, users,
 * categories, models) land in step 6.
 */
@Controller('api/v1')
@UseGuards(PatAuthGuard, ScopeGuard)
export class SnipeitCompatController {
  @Get('whoami')
  @RequireScope(SCOPE_READ)
  whoami(@Req() req: Request): unknown {
    const actor = req.actor;
    if (!actor || actor.kind !== 'pat') {
      // PatAuthGuard should have already populated this; if not, we
      // refuse to make up an answer.
      return { error: 'actor_missing' };
    }
    return {
      kind: actor.kind,
      userId: actor.userId,
      tenantId: actor.tenantId,
      scopes: actor.scopes,
      tokenId: actor.tokenId,
    };
  }
}
