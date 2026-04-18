import { Inject, Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
export interface PrismaServiceOptions {
  /** Override DATABASE_URL. Primarily useful in tests to connect as a
   * specific role (panorama_super_admin for cross-tenant setup, etc.). */
  datasourceUrl?: string;
}

export const PRISMA_SERVICE_OPTIONS = Symbol('PRISMA_SERVICE_OPTIONS');

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma');

  /**
   * The `@Inject + @Optional` pair lets Nest's DI resolve this constructor
   * without a concrete provider for `PrismaServiceOptions` (interfaces are
   * erased at runtime, so Nest would otherwise try to inject the `Object`
   * class). Under test, instantiate directly with
   * `new PrismaService({ datasourceUrl: ... })`.
   */
  constructor(
    @Inject(PRISMA_SERVICE_OPTIONS) @Optional() opts?: PrismaServiceOptions,
  ) {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      ...(opts?.datasourceUrl ? { datasources: { db: { url: opts.datasourceUrl } } } : {}),
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
