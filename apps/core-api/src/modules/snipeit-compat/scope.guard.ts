import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Per-endpoint scope requirement.
 *
 * Place `@RequireScope('snipeit.compat.read')` on each compat
 * controller method; `ScopeGuard` (registered module-wide) reads the
 * metadata and refuses requests whose `req.actor.scopes` don't
 * include the named scope. Defence-in-depth behind the PatAuthGuard
 * module boundary.
 */
export const REQUIRED_SCOPE_KEY = 'panorama:required_scope';

export const RequireScope = (scope: string): MethodDecorator =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope);

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.get<string | undefined>(
      REQUIRED_SCOPE_KEY,
      ctx.getHandler(),
    );
    if (!required) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const actor = req.actor;
    if (!actor || actor.kind !== 'pat') {
      // ScopeGuard runs AFTER PatAuthGuard — a missing actor means
      // guard order is wrong, not an authorisation decision. Fail
      // closed.
      throw new ForbiddenException('actor_missing');
    }
    if (!actor.scopes.includes(required)) {
      throw new ForbiddenException(`scope_required:${required}`);
    }
    return true;
  }
}
