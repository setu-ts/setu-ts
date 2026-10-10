/**
 * The real-PostgreSQL outbox harness (M107), shared by this package's
 * `outbox-store-real.test.ts` and `messaging-plugin`'s outbox relay suites so
 * the Drizzle table over the committed DDL fixture has ONE definition.
 *
 * Each harness creates a throwaway schema, applies `outbox-postgres.sql` (and a
 * business `orders` table) when asked, and hands back a Drizzle adapter whose
 * pool is pinned to that schema through `search_path`.
 *
 * @module
 */
import { drizzle } from 'npm:drizzle-orm@0.45.2/node-postgres';
import { bigint, integer, pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { Pool } from 'npm:pg@^8.0.0';
import { createDrizzleDatabase } from '../../src/index.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';

/** The Drizzle table over the committed DDL fixture's columns. */
export const outboxTable = pgTable('setu_outbox', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  topic: text('topic').notNull(),
  envelope: text('envelope').notNull(),
  options: text('options').notNull(),
  orderingKey: text('ordering_key'),
  tenantId: text('tenant_id'),
  traceparent: text('traceparent'),
  position: text('position').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  availableAt: bigint('available_at', { mode: 'number' }).notNull(),
  claimVersion: bigint('claim_version', { mode: 'number' }).notNull(),
  leaseUntil: bigint('lease_until', { mode: 'number' }).notNull(),
  lastError: text('last_error'),
  settledAt: bigint('settled_at', { mode: 'number' }),
  sentBy: text('sent_by'),
});

/** A business table sharing the outbox's transaction. */
export const ordersTable = pgTable('orders', {
  id: text('id').primaryKey(),
  total: integer('total').notNull(),
});

/** The committed PostgreSQL DDL — the text the README embeds verbatim. */
export function outboxPostgresDdl(): Promise<string> {
  return Deno.readTextFile(new URL('./outbox-postgres.sql', import.meta.url));
}

/**
 * A Drizzle adapter (not yet connected) over a pool, registering `Outbox` and
 * `Order` — call it again for a second "process" over the same schema.
 *
 * @param pool - A pool whose connections use the schema
 * @returns The adapter
 */
export function drizzleOutboxAdapter(pool: Pool): DrizzleAdapter {
  return new DrizzleAdapter({
    drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
    drizzleTables: { Outbox: outboxTable, Order: ordersTable },
  });
}

/** A throwaway schema and a Drizzle adapter over it. */
export interface PostgresOutboxSchema {
  /** The schema name. */
  readonly schema: string;
  /** A pool whose connections all use the schema. */
  readonly pool: Pool;
  /** A Drizzle adapter (not yet connected) registering `Outbox` and `Order`. */
  readonly adapter: DrizzleAdapter;
  /** Ends the pool and drops the schema. */
  readonly dispose: () => Promise<void>;
}

/**
 * Creates a throwaway schema, optionally applying the DDL fixture and an
 * `orders` table.
 *
 * @param url - The PostgreSQL connection string
 * @param withTable - Whether to create the outbox and orders tables
 * @param poolSize - Connections in the schema's pool (an open transaction holds one)
 * @returns The schema harness
 */
export async function postgresOutboxSchema(
  url: string,
  withTable: boolean,
  poolSize = 4,
): Promise<PostgresOutboxSchema> {
  const schema = `m107_outbox_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({
    connectionString: url,
    max: poolSize,
    options: `-c search_path=${schema}`,
  });
  if (withTable) {
    await pool.query(await outboxPostgresDdl());
    await pool.query('CREATE TABLE orders (id text PRIMARY KEY, total integer NOT NULL)');
  }
  const adapter = drizzleOutboxAdapter(pool);
  return {
    schema,
    pool,
    adapter,
    dispose: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
