/**
 * Prisma 7 CLI config for the live-suite fixtures (plan §1B): the schema's
 * datasource block carries ONLY `provider` — a `url` in the schema file fails
 * validation with P1012 — so the datasource URL, the schema path and the
 * migrations path live here.
 *
 * Run the CLI from THIS directory (test/fixtures):
 *
 * ```bash
 * DATABASE_URL='postgresql://postgres:probe@127.0.0.1:5433/m79probe' \
 *   npx prisma@7.10.0 db push && npx prisma@7.10.0 generate
 * ```
 *
 * `defineConfig` from 'prisma/config' is deliberately NOT imported: the
 * npx-run CLI cannot resolve bare specifiers from this directory (there is no
 * node_modules here by design — the suite itself resolves @prisma/client, the
 * pg driver and the generated client through Deno's import map). The CLI
 * validates this object's shape when it loads the file.
 *
 * The generated client lands in `prisma-client-generated/`, which is
 * git-ignored — the M70j precedent commits no generated client.
 *
 * @module
 */
import process from 'node:process';

export default {
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
};
