import { Inject, Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { currentTenantId } from '../tenant/tenant.context.js';

/**
 * Postgres serialization-failure SQLSTATE. Surfaced by Prisma as
 * `PrismaClientKnownRequestError` with code `P2034`. When we run a
 * transaction at Serializable isolation, the DB can abort one of two
 * racing transactions with this error — the contract is that the
 * caller retries and the surviving one wins.
 */
const SERIALIZATION_FAILURE_CODE = 'P2034';

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
   *
   * Optional `isolationLevel` — defaults to Postgres ReadCommitted.
   * Pass `'Serializable'` on write paths that need true mutual
   * exclusion (reservation create, membership role changes). Callers
   * using Serializable get automatic retry on serialization failure
   * (SQLSTATE 40001 → Prisma P2034) up to `retries` attempts.
   */
  async runInTenant<T>(
    tenantIdOrNull: string | null | undefined,
    cb: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: TxIsolationOptions = {},
  ): Promise<T> {
    const tenantId = tenantIdOrNull ?? currentTenantId();
    if (!tenantId) {
      throw new Error('Prisma runInTenant called without a tenant — refusing to leak rows.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error(`Prisma runInTenant got a non-UUID tenant id: ${tenantId}`);
    }

    return this.runTxWithRetry(
      (tx) => tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenantId}'`).then(() => cb(tx)),
      opts,
    );
  }

  /**
   * Explicit cross-tenant escape hatch. Opens a transaction and promotes
   * the session role to `panorama_super_admin` for its duration via
   * `SET LOCAL ROLE`. The app role must have been granted membership in
   * `panorama_super_admin` (see migration 0003's rls.sql — grants are
   * idempotent). At COMMIT/ROLLBACK the role reverts automatically.
   *
   * Logs a structured warning so the audit stream can spot unexpected usage.
   *
   * Same `isolationLevel` + retry semantics as `runInTenant`.
   */
  async runAsSuperAdmin<T>(
    cb: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { reason: string } & TxIsolationOptions,
  ): Promise<T> {
    this.log.warn({ reason: opts.reason }, 'runAsSuperAdmin');
    return this.runTxWithRetry(
      (tx) => tx.$executeRawUnsafe('SET LOCAL ROLE panorama_super_admin').then(() => cb(tx)),
      opts,
    );
  }

  /**
   * Internal helper: opens a $transaction at the requested isolation
   * level, retries on Postgres serialization failure (P2034) with
   * modest jittered backoff. Callers who didn't ask for Serializable
   * get no retry — serialization failure at ReadCommitted is a bug
   * somewhere else.
   */
  private async runTxWithRetry<T>(
    inner: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: TxIsolationOptions,
  ): Promise<T> {
    const isolation = opts.isolationLevel;
    const maxAttempts = isolation === 'Serializable' ? (opts.retries ?? 3) : 1;
    const txOptions: { isolationLevel?: Prisma.TransactionIsolationLevel } = {};
    if (isolation) {
      txOptions.isolationLevel =
        Prisma.TransactionIsolationLevel[isolation as keyof typeof Prisma.TransactionIsolationLevel];
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.$transaction(inner, txOptions);
      } catch (err) {
        if (!this.isSerializationFailure(err) || attempt === maxAttempts) {
          throw err;
        }
        lastErr = err;
        await new Promise((resolve) =>
          setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 10)),
        );
      }
    }
    // Unreachable — the loop above either returns or throws.
    throw lastErr ?? new Error('runTxWithRetry: unexpected exit');
  }

  private isSerializationFailure(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === SERIALIZATION_FAILURE_CODE
    );
  }
}

/**
 * Shared options surface for the two entry points. Kept small — callers
 * who need a more exotic isolation (Repeatable Read) can extend later.
 */
export interface TxIsolationOptions {
  isolationLevel?: 'Serializable' | 'RepeatableRead' | 'ReadCommitted';
  /** Max attempts including the first try. Defaults to 3 for Serializable, 1 otherwise. */
  retries?: number;
}
