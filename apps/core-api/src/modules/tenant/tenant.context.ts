import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant context.
 *
 * Set by TenantMiddleware on every incoming HTTP request; read by PrismaService
 * when it opens a transaction so it can emit `SET LOCAL app.current_tenant`.
 *
 * `tenantId` may be null for cross-tenant service code paths (super admin
 * dashboards, migrations, backups). Those paths must explicitly connect as
 * the `panorama_super_admin` DB role so Postgres RLS is bypassed; the
 * application layer does not hide the fact that it's running cross-tenant.
 */
export interface TenantContext {
  tenantId: string | null;
  userId: string | null;
  /** Human label for logs — don't use for authorisation. */
  actorEmail: string | null;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runInContext<T>(ctx: TenantContext, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(ctx, fn);
}

export function currentContext(): TenantContext {
  return storage.getStore() ?? { tenantId: null, userId: null, actorEmail: null };
}

export function currentTenantId(): string | null {
  return currentContext().tenantId;
}

export function currentUserId(): string | null {
  return currentContext().userId;
}
