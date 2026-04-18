import { Injectable } from '@nestjs/common';

/**
 * Invitation-flow tunables (ADR-0008).
 *
 * Community defaults ship here; enterprise overrides arrive later via
 * SystemSetting + Tenant-scoped overrides. Keep everything behind a
 * single service so rate-limit tests can stub a friendlier floor.
 */
@Injectable()
export class InvitationConfigService {
  readonly adminHourlyLimit = Number(process.env.INVITE_RATE_ADMIN_HOUR ?? 100);
  readonly tenantDailyLimit = Number(process.env.INVITE_RATE_TENANT_DAY ?? 1000);
  readonly adminWindowMs = 60 * 60 * 1000;
  readonly tenantWindowMs = 24 * 60 * 60 * 1000;

  /** Community TTL bounds in seconds. */
  readonly minTtlSeconds = 60 * 60; // 1 h
  readonly maxTtlSeconds = 60 * 60 * 24 * 30; // 30 d
  readonly defaultTtlSeconds = 60 * 60 * 24 * 7; // 7 d

  readonly allowedRoles: ReadonlyArray<string> = [
    'owner',
    'fleet_admin',
    'fleet_staff',
    'driver',
  ];

  /** Base URL used in the acceptance link inside the email. */
  readonly acceptBaseUrl =
    (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '') +
    '/invitations/accept';
}
