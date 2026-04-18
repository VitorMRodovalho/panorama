import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { currentTenantId } from '../tenant/tenant.context.js';

/**
 * Injectable Prisma wrapper with two safety rails:
 *
 *   1. `runInTenant(tenantId, cb)` — opens a transaction, emits
 *      `SET LOCAL app.current_tenant = '<uuid>'`, and runs the callback on
 *      the transactional client. Postgres RLS policies read that GUC and
 *      enforce row-level isolation even if the application layer forgets
 *      to include a tenant filter.
 *
 *   2. `runAsSuperAdmin(cb)` — explicit escape hatch for cross-tenant
 *      flows (super admin dashboards, migrations, backups). The expectation
 *      is that this method is called from a PrismaService instance
 *      connected as the `panorama_super_admin` DB role, which has BYPASSRLS.
 *      Runtime still opens a transaction so we can audit what was done.
 *
 * Controllers should never call `this.prisma.asset.findMany()` directly —
 * they go through `runInTenant` (or `runAsSuperAdmin`) so the RLS context
 * is always explicit.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma');

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.$on('warn' as never, (e: Prisma.LogEvent) =>
      this.log.warn({ target: e.target, message: e.message }),
    );
    this.$on('error' as never, (e: Prisma.LogEvent) =>
      this.log.error({ target: e.target, message: e.message }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `cb` inside a transaction that has `app.current_tenant` set to
   * `tenantId`. The tenant UUID is validated before being interpolated into
   * the SET LOCAL — we do not trust a caller-supplied string here.
   *
   * If `tenantId` is falsy, the current context is consulted via
   * AsyncLocalStorage (typical path for HTTP handlers). A null context
   * raises — callers must either pass a tenant explicitly or use
   * `runAsSuperAdmin`.
   */
  async runInTenant<T>(
    tenantIdOrNull: string | null | undefined,
    cb: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const tenantId = tenantIdOrNull ?? currentTenantId();
    if (!tenantId) {
      throw new Error('Prisma runInTenant called without a tenant — refusing to leak rows.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error(`Prisma runInTenant got a non-UUID tenant id: ${tenantId}`);
    }

    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenantId}'`);
      return cb(tx);
    });
  }

  /**
   * Explicit cross-tenant escape hatch. Logs a structured warning so the
   * audit stream can spot unexpected usage.
   */
  async runAsSuperAdmin<T>(
    cb: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { reason: string },
  ): Promise<T> {
    this.log.warn({ reason: opts.reason }, 'runAsSuperAdmin');
    return this.$transaction((tx) => cb(tx));
  }
}
