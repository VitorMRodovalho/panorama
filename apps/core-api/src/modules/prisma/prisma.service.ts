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
 * Fields whose plaintext we never want in a log line. Hashes live in
 * Postgres as pre-images to the real secret (password, PAT plaintext,
 * invitation token, email-hash) — tee'ing them to stdout via a stray
 * `log: ['query']` setting on an operator's machine is exactly the
 * "token in URL without server-side hash" failure mode adjacent.
 *
 * The redaction is belt-and-braces with never-enabling query logging
 * in production: if someone later flips `log: ['query']` on to debug,
 * the sensitive values are already blanked.
 *
 * Kept EXPORTED so test code can assert the redaction list hasn't
 * silently shrunk.
 */
export const PRISMA_REDACT_FIELDS = [
  'tokenHash',
  'password',
  'secretHash',
  'emailHash',
  // S3 / AWS SDK credential shapes — ObjectStorage errors (ADR-0012)
  // can leak these in SDK error dumps if a log line isn't scrubbed.
  // Field-name match catches both camelCase (SDK) and
  // SCREAMING_SNAKE_CASE (env) variants.
  'accessKeyId',
  'secretAccessKey',
  'AccessKeyId',
  'SecretAccessKey',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  // Authorization header sometimes appears verbatim in SDK
  // diagnostic dumps (signed-request trace) — scrub it.
  'authorization',
  'Authorization',
] as const;

const REDACTED = '<redacted>';
const SENSITIVE_QUERY_PATTERN = new RegExp(
  `"?(${PRISMA_REDACT_FIELDS.join('|')})"?`,
  'i',
);

/**
 * Redact sensitive field values from a freeform log string. Handles
 * the three shapes Prisma actually emits:
 *
 *   * JSON payload: `"tokenHash":"abc..."` → `"tokenHash":"<redacted>"`
 *   * Object literal: `tokenHash: 'abc'` → `tokenHash: '<redacted>'`
 *   * SQL literal: `"tokenHash" = 'abc'` → `"tokenHash" = '<redacted>'`
 *
 * Field names are matched word-bounded so `tokenHash` doesn't collide
 * with, say, `apiTokenHashedAt` (hypothetical). EXPORTED for unit tests.
 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const field of PRISMA_REDACT_FIELDS) {
    out = out.replace(
      new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, 'g'),
      `$1"${REDACTED}"`,
    );
    out = out.replace(
      new RegExp(`(\\b${field}\\s*:\\s*)['"][^'"]*['"]`, 'g'),
      `$1'${REDACTED}'`,
    );
    out = out.replace(
      new RegExp(`("?\\b${field}\\b"?\\s*=\\s*)'[^']*'`, 'g'),
      `$1'${REDACTED}'`,
    );
  }
  return out;
}

/**
 * Injectable Prisma wrapper with two safety rails:
 *
 *   1. `runInTenant(tenantId, cb)` — opens a transaction on the
 *      **app client** (DATABASE_URL, role `panorama_app` NOBYPASSRLS),
 *      emits `SET LOCAL panorama.current_tenant = '<uuid>'`, and runs
 *      the callback. Postgres RLS policies read that GUC and enforce
 *      row-level isolation even if the application layer forgets to
 *      include a tenant filter.
 *
 *   2. `runAsSuperAdmin(cb)` — explicit escape hatch for cross-tenant
 *      flows (audit writes, maintenance sweeps, owner-enforcement,
 *      auth's membership lookups). Opens a transaction on the
 *      **privileged client** (DATABASE_PRIVILEGED_URL, role
 *      `panorama_super_admin`), calls the SECURITY DEFINER function
 *      `panorama_enable_bypass_rls()` to set `panorama.bypass_rls = on`
 *      (tx-local), and runs the callback. The privileged-bypass
 *      policies on every tenant-scoped table read that GUC.
 *
 * Per ADR-0015 v2, the privileged role no longer carries the
 * BYPASSRLS attribute — its capability lives in the EXECUTE grant on
 * `panorama_enable_bypass_rls()`. SQL injection on the appClient
 * cannot reach that function (no EXECUTE grant for `panorama_app`),
 * which is the trust boundary that survived the data-architect +
 * security-reviewer + tech-lead ADR review.
 *
 * Controllers should never call `this.prisma.asset.findMany()` directly —
 * they go through `runInTenant` (or `runAsSuperAdmin`) so the RLS context
 * is always explicit.
 */
export interface PrismaServiceOptions {
  /** Override DATABASE_URL. Test-only — primarily for piping in a
   * specific role's connection string from a TestingModule. */
  datasourceUrl?: string;
  /** Override DATABASE_PRIVILEGED_URL. Test-only — same reasons.
   * When unset, the privileged client falls back to the env var; if
   * that's also unset, `runAsSuperAdmin` throws at first call. */
  privilegedDatasourceUrl?: string;
}

export const PRISMA_SERVICE_OPTIONS = Symbol('PRISMA_SERVICE_OPTIONS');

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma');

  /**
   * The privileged Prisma client (ADR-0015 v2). Connects under
   * `DATABASE_PRIVILEGED_URL` as the role with the EXECUTE grant on
   * `panorama_enable_bypass_rls()`. Lazily initialised on first use of
   * `runAsSuperAdmin` so a deploy that doesn't need privileged writes
   * (e.g. a read-only health check) never opens a second pool.
   *
   * **Forbidden**: passing the same URL as `DATABASE_URL`. The whole
   * point of the two-client pattern is that the EXECUTE grant on the
   * SECURITY DEFINER bypass function differs between roles. Same URL
   * → same role → SQL injection on the app surface can call the
   * function. Boot-time check enforces inequality.
   */
  private privilegedClient: PrismaClient | null = null;
  private readonly privilegedUrl: string | undefined;

  /**
   * The `@Inject + @Optional` pair lets Nest's DI resolve this constructor
   * without a concrete provider for `PrismaServiceOptions` (interfaces are
   * erased at runtime, so Nest would otherwise try to inject the `Object`
   * class). Under test, instantiate directly with
   * `new PrismaService({ datasourceUrl: ..., privilegedDatasourceUrl: ... })`.
   */
  constructor(
    @Inject(PRISMA_SERVICE_OPTIONS) @Optional() opts?: PrismaServiceOptions,
  ) {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'query' },
      ],
      ...(opts?.datasourceUrl ? { datasources: { db: { url: opts.datasourceUrl } } } : {}),
    });
    this.privilegedUrl =
      opts?.privilegedDatasourceUrl ?? process.env['DATABASE_PRIVILEGED_URL'];

    // Boot-time guard (production only): same URL for both clients
    // defeats the whole EXECUTE-grant trust boundary. Refuse loudly.
    // In dev / test we tolerate equal URLs because some e2e tests
    // instantiate a single super-admin-URL PrismaService for fixture
    // setup; the v2 trust boundary is a production posture, not a
    // dev one.
    const appUrl = opts?.datasourceUrl ?? process.env['DATABASE_URL'];
    if (
      process.env['NODE_ENV'] === 'production' &&
      this.privilegedUrl &&
      appUrl &&
      this.privilegedUrl === appUrl
    ) {
      throw new Error(
        'PrismaService: DATABASE_URL and DATABASE_PRIVILEGED_URL MUST differ ' +
          'in production. They identify the appClient (panorama_app, ' +
          'NOBYPASSRLS) and the privilegedClient (panorama_super_admin with ' +
          'EXECUTE grant on panorama_enable_bypass_rls). Same URL = same ' +
          'role = the bypass function is callable from the appClient = ' +
          'SQL-injection bypasses RLS.',
      );
    }

    // Redact plaintext + pre-image pairs (tokenHash, password, etc.)
    // from every Prisma-emitted log before it reaches the Nest logger.
    // Defence in depth — we don't enable `log: ['query']` in prod, but
    // an operator toggling it on to debug mustn't see pre-images.
    this.$on('warn' as never, (e: Prisma.LogEvent) =>
      this.log.warn({ target: e.target, message: redactSensitive(e.message) }),
    );
    this.$on('error' as never, (e: Prisma.LogEvent) =>
      this.log.error({ target: e.target, message: redactSensitive(e.message) }),
    );
    // Query events surface SQL + serialised params. If the query text
    // mentions a sensitive column name, blank the whole params vector
    // — we can't positionally map $1/$2/... back to columns without
    // parsing the SQL, and over-redaction is cheaper than a leak.
    this.$on('query' as never, (e: Prisma.QueryEvent) => {
      const params = SENSITIVE_QUERY_PATTERN.test(e.query) ? REDACTED : e.params;
      this.log.debug({
        target: 'query',
        query: redactSensitive(e.query),
        params,
        duration: e.duration,
      });
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    if (this.privilegedClient) {
      await this.privilegedClient.$disconnect();
      this.privilegedClient = null;
    }
  }

  /**
   * Lazy accessor for the privileged Prisma client (ADR-0015 v2). First
   * call connects + caches; subsequent calls reuse. Throws if no
   * `DATABASE_PRIVILEGED_URL` is configured — `runAsSuperAdmin` cannot
   * proceed without it. Exposed at protected scope so test doubles can
   * inject a mock; production code goes via `runAsSuperAdmin` only.
   */
  protected getPrivilegedClient(): PrismaClient {
    if (this.privilegedClient) return this.privilegedClient;
    if (!this.privilegedUrl) {
      throw new Error(
        'runAsSuperAdmin requires DATABASE_PRIVILEGED_URL. Per ADR-0015 v2 ' +
          'the privileged path uses a separate Prisma client connected as ' +
          'panorama_super_admin (NOBYPASSRLS, with EXECUTE grant on ' +
          'panorama_enable_bypass_rls()). Configure the env var or pass ' +
          'PrismaServiceOptions.privilegedDatasourceUrl in tests.',
      );
    }
    this.privilegedClient = new PrismaClient({
      datasources: { db: { url: this.privilegedUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    return this.privilegedClient;
  }

  /**
   * Run `cb` inside an appClient transaction that has
   * `panorama.current_tenant` set to `tenantId`. The tenant UUID is
   * validated before being interpolated into the `SET LOCAL` — caller-
   * supplied strings are NOT trusted.
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
      this,
      (tx) => tx.$executeRawUnsafe(`SET LOCAL panorama.current_tenant = '${tenantId}'`).then(() => cb(tx)),
      opts,
    );
  }

  /**
   * Explicit cross-tenant escape hatch (ADR-0015 v2). Opens a
   * transaction on the **privileged client**, calls
   * `panorama_enable_bypass_rls()` (a SECURITY DEFINER function whose
   * EXECUTE grant is restricted to `panorama_super_admin`), and runs
   * the callback. The privileged-bypass policies on every tenant-scoped
   * table read `panorama.bypass_rls` and let the privileged tx through.
   *
   * No role-switching via `SET LOCAL ROLE` (that path is gone). The
   * trust boundary is now (a) the EXECUTE grant on the bypass function
   * + (b) the connection identity of the privileged client. SQL
   * injection on the appClient surface can do neither.
   *
   * Logs a structured warning so the audit stream can spot unexpected
   * usage. Same `isolationLevel` + retry semantics as `runInTenant`.
   */
  async runAsSuperAdmin<T>(
    cb: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { reason: string } & TxIsolationOptions,
  ): Promise<T> {
    this.log.warn({ reason: opts.reason }, 'runAsSuperAdmin');
    return this.runTxWithRetry(
      this.getPrivilegedClient(),
      (tx) => tx.$executeRawUnsafe('SELECT panorama_enable_bypass_rls()').then(() => cb(tx)),
      opts,
    );
  }

  /**
   * Internal helper: opens a $transaction on the given client at the
   * requested isolation level, retries on Postgres serialization
   * failure (P2034) with modest jittered backoff. Callers who didn't
   * ask for Serializable get no retry — serialization failure at
   * ReadCommitted is a bug somewhere else.
   */
  private async runTxWithRetry<T>(
    client: PrismaClient,
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
        return await client.$transaction(inner, txOptions);
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
