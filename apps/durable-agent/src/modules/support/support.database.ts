import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createDrizzleDatabase, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IPlugin } from '@setu-ts/common';
import { SUPPORT_TABLES } from './support.tables.ts';

/**
 * The database the example stores orders, refunds, idempotency records and
 * agent runs in.
 *
 * `DATABASE_URL` set: Drizzle on PostgreSQL. Run `npm run db:setup` once to
 * create the tables from `schema.sql`; a run then survives a restart of the
 * process serving it. Unset: the memory database, which loses every run when
 * the process stops.
 *
 * @param env - The process environment
 * @returns The database plugin, plus one that ends the pool on shutdown
 */
export function supportDatabase(env: Readonly<Record<string, string | undefined>>): IPlugin[] {
  const url = env['DATABASE_URL'];
  if (!url) return [DatabasePlugin({ type: 'memory' })];
  const pool = new Pool({ connectionString: url, max: 8 });
  return [
    DatabasePlugin({
      type: 'drizzle',
      options: {
        drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
        drizzleTables: SUPPORT_TABLES,
      },
    }),
    {
      // DatabasePlugin closes its adapter, never the pool it was handed.
      name: 'support-database-pool',
      version: '0.1.0',
      register(ctx) {
        ctx.lifecycle.onClose(() => pool.end());
      },
    },
  ];
}
