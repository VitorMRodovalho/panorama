import { Injectable } from '@nestjs/common';

/**
 * Tenant-scoped reservation rules (ADR-0009). Lives on
 * `Tenant.reservationRules` as a JSON column; this service parses + coerces
 * the shape so the service layer doesn't re-do it at every call site.
 *
 * Community defaults are "not enforced" (zeros) + staff / admin / owner in
 * the auto-approve list. Enterprise can bolt a UI on top; CLI + SQL for 0.x.
 */

export interface ReservationRules {
  minNoticeHours: number;
  maxDurationHours: number;
  maxConcurrentPerUser: number;
  autoApproveRoles: string[];
}

export const DEFAULT_AUTO_APPROVE_ROLES = ['owner', 'fleet_admin', 'fleet_staff'];

@Injectable()
export class ReservationConfigService {
  fromJson(raw: unknown): ReservationRules {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const minNoticeHours = coerceInt(obj['min_notice_hours'], 0);
    const maxDurationHours = coerceInt(obj['max_duration_hours'], 0);
    const maxConcurrentPerUser = coerceInt(obj['max_concurrent_per_user'], 0);
    const autoApproveRoles = Array.isArray(obj['auto_approve_roles'])
      ? (obj['auto_approve_roles'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : DEFAULT_AUTO_APPROVE_ROLES;
    return {
      minNoticeHours: Math.max(0, minNoticeHours),
      maxDurationHours: Math.max(0, maxDurationHours),
      maxConcurrentPerUser: Math.max(0, maxConcurrentPerUser),
      autoApproveRoles: autoApproveRoles.length > 0 ? autoApproveRoles : DEFAULT_AUTO_APPROVE_ROLES,
    };
  }
}

function coerceInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}
