import type { Prisma } from '@prisma/client';

/**
 * Prisma middleware that enforces tenant scoping on every query.
 * Pairs with the Postgres RLS policy (see prisma/migrations/*/rls.sql) —
 * defence in depth.
 *
 * Usage:
 *   prisma.$use(tenantMiddleware(() => ctx.tenantId));
 *
 * The getter returns `null` for cross-tenant service contexts (super admin
 * dashboards, migrations, backups). In those cases we skip scoping — but
 * RLS still requires the caller to be `panorama_super_admin` at the DB
 * role level, so a bug here cannot leak across tenants.
 */
export function tenantMiddleware(
  getTenantId: () => string | null,
): Prisma.Middleware {
  return async (params, next) => {
    const tenantId = getTenantId();

    const scoped = TENANT_SCOPED_MODELS.has(params.model ?? '');
    if (!scoped) return next(params);

    if (tenantId === null) {
      // Explicit opt-out: cross-tenant scope. Caller must run as super_admin DB role.
      return next(params);
    }

    switch (params.action) {
      case 'findUnique':
      case 'findFirst':
      case 'findMany':
      case 'count':
      case 'aggregate':
      case 'groupBy': {
        params.args = injectTenantFilter(params.args, tenantId);
        break;
      }
      case 'update':
      case 'updateMany':
      case 'delete':
      case 'deleteMany': {
        params.args = injectTenantFilter(params.args, tenantId);
        break;
      }
      case 'create': {
        params.args = injectTenantOnCreate(params.args, tenantId);
        break;
      }
      case 'createMany': {
        if (Array.isArray(params.args?.data)) {
          params.args.data = params.args.data.map((row: Record<string, unknown>) => ({
            tenantId,
            ...row,
          }));
        }
        break;
      }
      case 'upsert': {
        params.args = injectTenantFilter(params.args, tenantId);
        params.args.create = { tenantId, ...(params.args.create ?? {}) };
        break;
      }
      default:
        break;
    }

    return next(params);
  };
}

const TENANT_SCOPED_MODELS = new Set<string>([
  'Tenant', // self; but we still want RLS-gated reads to be tenant-aware
  'Category',
  'Manufacturer',
  'AssetModel',
  'Asset',
  'Reservation',
  'TenantMembership',
]);

function injectTenantFilter(
  args: Record<string, unknown> | undefined,
  tenantId: string,
): Record<string, unknown> {
  const next = { ...(args ?? {}) };
  const where = (next.where as Record<string, unknown> | undefined) ?? {};
  next.where = { ...where, tenantId };
  return next;
}

function injectTenantOnCreate(
  args: Record<string, unknown> | undefined,
  tenantId: string,
): Record<string, unknown> {
  const next = { ...(args ?? {}) };
  const data = (next.data as Record<string, unknown> | undefined) ?? {};
  next.data = { tenantId, ...data };
  return next;
}
