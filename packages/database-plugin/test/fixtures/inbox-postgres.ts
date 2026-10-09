/**
 * The real-PostgreSQL inbox harness (M108), used by `messaging-plugin`'s inbox
 * suites so the Drizzle table over the committed DDL fixture has ONE
 * definition.
 *
 * Each harness creates a throwaway schema, applies `inbox-postgres.sql` and
 * `outbox-postgres.sql` (the end-to-end case relays through the outbox) plus a
 * business `people` table, and hands back Drizzle adapters whose pools are
 * pinned to that schema through `search_path`.
 *
 * @module
 */
import { drizzle } from 'npm:drizzle-orm@0.45.2/node-postgres';
import { bigint, integer, pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { Pool } from 'npm:pg@^8.0.0';
import { createDrizzleDatabase } from '../../src/index.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { outboxPostgresDdl, outboxTable } from './outbox-postgres.ts';

/** The Drizzle table over the committed inbox DDL fixture's columns. */
export const inboxTable = pgTable('setu_inbox', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  consumer: text('consumer').notNull(),
  topic: text('topic').notNull(),
  envelopeId: text('envelope_id'),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastError: text('last_error'),
  envelope: text('envelope'),
});

/** A business table the handlers write through the inbox's unit of work. */
export const peopleTable = pgTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

/** The committed PostgreSQL inbox DDL — the text the README embeds verbatim. */
export function inboxPostgresDdl(): Promise<string> {
  return Deno.readTextFile(new URL('./inbox-postgres.sql', import.meta.url));
}

/**
 * A Drizzle adapter (not yet connected) registering `Inbox`, `Outbox` and
 * `Person` — call it again for a second "process" over the same schema.
 *
 * @param pool - A pool whose connections use the schema
 * @returns The adapter
 */
export function drizzleInboxAdapter(pool: Pool): DrizzleAdapter {
  return new DrizzleAdapter({
    drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
    drizzleTables: { Inbox: inboxTable, Outbox: outboxTable, Person: peopleTable },
  });
}

/** A throwaway schema with the inbox, outbox and people tables. */
export interface PostgresInboxSchema {
  /** A pool whose connections all use the schema. */
  readonly pool: Pool;
  /** Ends the pool and drops the schema. */
  readonly dispose: () => Promise<void>;
}

/**
 * Creates a throwaway schema with the committed DDL applied.
 *
 * @param url - The PostgreSQL connection string
 * @param poolSize - Connections in the schema's pool (an open transaction holds one)
 * @returns The schema harness
 */
export async function postgresInboxSchema(url: string, poolSize = 6): Promise<PostgresInboxSchema> {
  const schema = `m108_inbox_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({
    connectionString: url,
    max: poolSize,
    options: `-c search_path=${schema}`,
  });
  await pool.query(await inboxPostgresDdl());
  await pool.query(await outboxPostgresDdl());
  await pool.query('CREATE TABLE people (id text PRIMARY KEY, name text NOT NULL)');
  return {
    pool,
    dispose: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
