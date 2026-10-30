import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma ORM 7 talks to Postgres through a driver adapter
 * (`@prisma/adapter-pg`, i.e. node-postgres) instead of the Rust query
 * engine. Every PrismaClient in this app — the two PrismaService
 * clients, CLI scripts, seeds and test fixtures — is built from the
 * adapter below so pool behaviour stays uniform.
 *
 * Pool defaults now come from `pg`, not Prisma. Two of them differ
 * from Prisma 6 in ways that matter for a long-running API, so they are
 * pinned back to the Prisma 6 values, as the upgrade guide recommends
 * (https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool#prisma-orm-v7-driver-adapter-defaults):
 *
 *   * `connectionTimeoutMillis` — pg default is 0 (wait forever);
 *     Prisma 6 gave up after 5 s.
 *   * `idleTimeoutMillis` — pg default is 10 s; Prisma 6 kept idle
 *     connections for 300 s.
 *
 * Prisma 6 also read pool settings from the connection URL. `pg`
 * ignores Prisma-only query parameters, so the two that change
 * behaviour are translated explicitly:
 *
 *   * `connection_limit=N` → pg `max` (pool size). Without it the pool
 *     size is pg's default of 10.
 *   * `schema=NAME` → the adapter's `schema` option (the schema Prisma
 *     qualifies generated queries with).
 *
 * Other Prisma 6 URL parameters (`pgbouncer`, `pool_timeout`,
 * `connect_timeout`, `socket_timeout`, `statement_cache_size`) have no
 * effect under Prisma 7: the adapter never caches named prepared
 * statements, so a transaction-mode pooler works without `pgbouncer`.
 *
 * Interactive transactions (`$transaction(async (tx) => …)`) check out
 * ONE pooled connection, run `BEGIN`, every `tx` query and
 * `COMMIT`/`ROLLBACK` on it, then release it. That is what keeps
 * `SET LOCAL panorama.current_tenant` and `panorama_enable_bypass_rls()`
 * scoped to the transaction that issued them (see PrismaService).
 */
export const PRISMA_V6_POOL_DEFAULTS = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
} as const;

export interface PgAdapterSettings {
  max?: number;
  schema?: string;
}

/**
 * Reads the Prisma 6 URL parameters that still need to mean something
 * (see above). Returns `{}` for a URL that `URL` cannot parse; pg then
 * reports the malformed string itself on first connect. EXPORTED for
 * unit tests.
 */
export function pgAdapterSettingsFromUrl(connectionString: string): PgAdapterSettings {
  let params: URLSearchParams;
  try {
    params = new URL(connectionString).searchParams;
  } catch {
    return {};
  }
  const settings: PgAdapterSettings = {};
  const limit = params.get('connection_limit');
  if (limit !== null) {
    const max = Number(limit);
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(
        `Invalid connection_limit in the database URL: expected a positive integer, got "${limit}".`,
      );
    }
    settings.max = max;
  }
  const schema = params.get('schema');
  if (schema) settings.schema = schema;
  return settings;
}

/** Driver adapter for one Postgres connection string. */
export function createPgAdapter(connectionString: string): PrismaPg {
  const { max, schema } = pgAdapterSettingsFromUrl(connectionString);
  return new PrismaPg(
    {
      connectionString,
      ...PRISMA_V6_POOL_DEFAULTS,
      ...(max !== undefined ? { max } : {}),
    },
    schema ? { schema } : undefined,
  );
}

/**
 * Plain PrismaClient for scripts, seeds and test fixtures. Application
 * code goes through PrismaService (`runInTenant` / `runAsSuperAdmin`),
 * never through a client built here.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: createPgAdapter(connectionString) });
}
