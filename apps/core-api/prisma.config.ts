/**
 * Prisma CLI configuration (Prisma ORM 7). Read by every `prisma`
 * command run from apps/core-api: `generate`, `migrate deploy`,
 * `migrate dev`, `db seed`, and the migrator image's
 * scripts/apply-migrations.sh.
 *
 * Prisma 7 no longer loads `.env` on its own. `dotenv` restores the
 * Prisma 6 behaviour for local development (apps/core-api/.env, see
 * docs/en/quickstart.md). It never overrides a variable that is
 * already set, so the CI job env and apply-migrations.sh's
 * `DATABASE_URL="$MIGRATE_URL"` still win, and an image with no `.env`
 * is unaffected.
 *
 * `datasource.url` is the connection the CLI uses for migrations. It
 * reads `process.env` directly instead of the `env()` helper because
 * `env()` throws when the variable is missing, and `prisma generate`
 * (CI lint job, Docker builder stage) runs without a database. A
 * command that needs the database fails on the empty URL instead.
 * Pooled endpoints are not suitable here: apply-migrations.sh swaps in
 * DATABASE_DIRECT_URL when it is set.
 *
 * The application does not read this file: PrismaService builds its
 * clients from DATABASE_URL / DATABASE_PRIVILEGED_URL through the
 * `@prisma/adapter-pg` driver adapter
 * (src/modules/prisma/prisma-client.factory.ts).
 *
 * https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference
 */
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` (the `prisma:seed` script). Prisma 7 no longer
    // runs the seed implicitly after `migrate dev` / `migrate reset`.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
