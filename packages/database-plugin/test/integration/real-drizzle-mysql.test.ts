/** MYSQL_URL, like POSTGRES_URL, selects a shared backend and runs in isolation. */
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlHarness } from '../fixtures/mysql-harness.ts';

describe('Drizzle real MySQL repository', { skip: !process.env['MYSQL_URL'] }, () => {
  it('writes, reads, escapes literal contains under both sql modes, and pages without a limit', async () => {
    const h = await mysqlHarness('drizzle');
    try {
      const repo = h.database.getRepository<Record<string, unknown>>('Row');
      for (const [id, name] of [['a','50%_!\\off'],['b','ordinary'],['c','third']]) await repo.create({ id, name, version: 1, balance: 100 });
      const connection = await h.pool.getConnection();
      try {
        const [settings] = await connection.query<RowDataPacket[]>('SELECT @@session.sql_mode AS mode');
        const original = String(settings[0]!.mode);
        for (const mode of [original, `${original},NO_BACKSLASH_ESCAPES`]) {
          // Pin the pool to one connection while the session mode is changed.
          await connection.query('SET SESSION sql_mode = ?', [mode]);
          const { drizzle } = await import('drizzle-orm/mysql2');
          const { createDrizzleDatabase, DrizzleAdapter, DatabaseService } = await import('../../src/index.ts');
          const { mysqlTables } = await import('../fixtures/mysql-tables.ts');
          const adapter = new DrizzleAdapter({ drizzleInstance: createDrizzleDatabase(drizzle(connection), (db, work) => db.transaction(work)), drizzleTables: mysqlTables, dialect: 'mysql' });
          await adapter.connect();
          const db = new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'drizzle');
          try {
            for (const value of ['%', '_', '!', '\\']) {
              expect((await db.getRepository<Record<string, unknown>>('Row').findAll({ filter: { type: 'comparison', field: ['name'], operator: 'contains', value } })).map((row) => row.id)).toEqual(['a']);
            }
          } finally { await db.close(); }
        }
        await connection.query('SET SESSION sql_mode = ?', [original]);
      } finally { connection.release(); }
      expect((await repo.findAll({ offset: 1, orderBy: { id: 'asc' } })).map((row) => row.id)).toEqual(['b', 'c']);
      expect(await repo.update('b', { name: 'ordinary' })).toMatchObject({ id: 'b' });
      expect(await repo.updateWhere!('b', { version: 1 }, { version: 1 })).toMatchObject({ id: 'b' });
      expect(await repo.delete('c')).toBe(true);
      expect(await repo.findById('c')).toBeNull();
    } finally { await h.dispose(); }
  });
});
