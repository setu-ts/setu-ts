import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  createDrizzleDatabase,
  createMigrationLedger,
  DatabaseService,
  DrizzleAdapter,
} from '../../src/index.ts';
import { createMigrationReadiness } from '../../src/migrations/migration-readiness.ts';

const url = process.env['OUTBOX_POSTGRES_URL'];
const table = pgTable('setu_migrations', {
  id: text('id').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

describe('migration ledger over real PostgreSQL', { skip: url === undefined }, () => {
  it('uses the shipped DDL, reads persisted history, rejects duplicates, and treats a missing table as unreadable', async () => {
    const schema = `m113o_${crypto.randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: url!, options: `-c search_path=${schema}` });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
      drizzleTables: { setu_migrations: table },
    });
    const database = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'drizzle',
    );
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        await readFile(
          new URL('../fixtures/migration-ledger-postgres.sql', import.meta.url),
          'utf8',
        ),
      );
      await adapter.connect();
      const ledger = createMigrationLedger(database);
      await ledger.record('one', '2026-10-19T00:00:00.000Z');
      expect(await createMigrationLedger(database).applied()).toEqual(['one']);
      expect(await database.getRepository('setu_migrations').findById('one')).toEqual({
        id: 'one',
        appliedAt: '2026-10-19T00:00:00.000Z',
      });
      await expect(ledger.record('one', 'later')).rejects.toBeInstanceOf(Error);
      await ledger.remove('one');
      await ledger.remove('absent');
      expect(await ledger.applied()).toEqual([]);
      await pool.query('DROP TABLE setu_migrations');
      const evaluate = createMigrationReadiness(
        database,
        { migrations: ['one'] },
        {
          hrtime: () => performance.now(),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      );
      expect(await evaluate({ status: 'up' })).toEqual({
        status: 'down',
        data: { migrations: { state: 'unreadable' } },
      });
    } finally {
      await database.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
});
