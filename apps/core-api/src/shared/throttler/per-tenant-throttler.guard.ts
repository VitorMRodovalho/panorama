import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { currentTenantId } from '../../modules/tenant/tenant.context.js';

/**
 * Per-tenant rate-limiting guard (Wave 0 Round 2A.2 per
 * HANDOFF-2026-05-16-wave0-scan.md — tech-lead C5 + security-reviewer
 * B1 follow-up).
 *
 * Overrides the default IP-only key with `${tenantId}:${ip}`. Reasoning:
 *
 * - Authenticated routes get bucketed PER TENANT + PER IP. One tenant
 *   under load doesn't starve other tenants behind the same egress IP
 *   (e.g., shared corporate NAT).
 * - Anonymous routes (login, OIDC callback, invitation accept) have no
 *   tenant in the ALS context, so they fall back to IP-only — same as
 *   the default ThrottlerGuard. That's the correct shape: pre-auth
 *   abuse can only be tracked by IP.
 * - The ALS context is populated by SessionMiddleware before guards
 *   run, so `currentTenantId()` is the authoritative tenant on every
 *   authenticated request.
 *
 * The fall-back to `'unknown'` for missing IP is defensive — Fly's
 * edge always populates X-Forwarded-For, but a misconfigured proxy
 * could theoretically strip it. `'unknown'` is the shared bucket for
 * all such mis-shaped requests, which is the conservative choice.
 */
@Injectable()
export class PerTenantThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    const tenantId = currentTenantId();
    const ip = req.ip ?? 'unknown';
    return tenantId ? `${tenantId}:${ip}` : ip;
  }
}
