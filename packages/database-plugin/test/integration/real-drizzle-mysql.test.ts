/** MYSQL_URL, like POSTGRES_URL, selects a shared backend and runs in isolation. */
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlHarness } from '../fixtures/mysql-harness.ts';
import { mysqlConditionCells } from '../fixtures/mysql-condition-cells.ts';

it(
  'mysql2 serves FK, NOT NULL, length and lock timeout with rollback',
  { skip: !process.env['MYSQL_URL'] },
  async () => {
    await mysqlConditionCells('drizzle');
  },
);

describe('Drizzle real MySQL repository', { skip: !process.env['MYSQL_URL'] }, () => {
  it('writes, reads, escapes literal contains, refuses NO_BACKSLASH_ESCAPES at connect, and pages without a limit', async () => {
    const h = await mysqlHarness('drizzle');
    try {
      const repo = h.database.getRepository<Record<string, unknown>>('Row');
      for (const [id, name] of [
        ['a', '50%_!\\off'],
        ['b', 'ordinary'],
        ['c', 'third'],
      ])
        await repo.create({ id, name, version: 1, balance: 100 });
      const connection = await h.pool.getConnection();
      try {
        const [settings] = await connection.query<RowDataPacket[]>(
          'SELECT @@session.sql_mode AS mode',
        );
        const original = String(settings[0]!.mode);
        const { drizzle } = await import('drizzle-orm/mysql2');
        const { eq } = await import('drizzle-orm');
        const { createDrizzleDatabase, DrizzleAdapter, DatabaseService, UnsupportedSqlModeError } =
          await import('../../src/index.ts');
        const { mysqlTables } = await import('../fixtures/mysql-tables.ts');
        // One pinned connection, so the session mode set here is the one the adapter reads.
        const adapterOn = () =>
          new DrizzleAdapter({
            drizzleInstance: createDrizzleDatabase(drizzle(connection), (db, work) =>
              db.transaction(work),
            ),
            drizzleTables: mysqlTables,
            dialect: 'mysql',
          });
        const adapter = adapterOn();
        await adapter.connect();
        const db = new DatabaseService(
          adapter,
          (entity) => adapter.createDataSource(entity),
          'drizzle',
        );
        try {
          for (const value of ['%', '_', '!', '\\']) {
            expect(
              (
                await db.getRepository<Record<string, unknown>>('Row').findAll({
                  filter: { type: 'comparison', field: ['name'], operator: 'contains', value },
                })
              ).map((row) => row.id),
            ).toEqual(['a']);
          }
          expect(
            await db.getRepository<Record<string, unknown>>('Row').findAll({
              filter: { type: 'comparison', field: ['id'], operator: 'eq', value: "' OR 1=1 -- " },
            }),
          ).toEqual([]);
        } finally {
          await db.close();
        }
        await connection.query('SET SESSION sql_mode = ?', [`${original},NO_BACKSLASH_ESCAPES`]);
        try {
          await expect(adapterOn().connect()).rejects.toBeInstanceOf(UnsupportedSqlModeError);
          // Negative control: the same bound value through the raw Drizzle instance,
          // which the refusal stands in front of, breaks out of its literal.
          const injected = await drizzle(connection)
            .select()
            .from(mysqlTables.Row)
            .where(eq(mysqlTables.Row.id, "' OR 1=1 -- "));
          expect(injected.map((row) => row.id).sort()).toEqual(['a', 'b', 'c']);
        } finally {
          await connection.query('SET SESSION sql_mode = ?', [original]);
        }
      } finally {
        connection.release();
      }
      expect(
        (await repo.findAll({ offset: 1, orderBy: { id: 'asc' } })).map((row) => row.id),
      ).toEqual(['b', 'c']);
      expect(await repo.update('b', { name: 'ordinary' })).toMatchObject({ id: 'b' });
      expect(await repo.updateWhere!('b', { version: 1 }, { version: 1 })).toMatchObject({
        id: 'b',
      });
      expect(await repo.delete('c')).toBe(true);
      expect(await repo.findById('c')).toBeNull();
    } finally {
      await h.dispose();
    }
  });
});

describe('Drizzle real MySQL withReplicas()', { skip: !process.env['MYSQL_URL'] }, () => {
  it('reads the replica too: a replica session under NO_BACKSLASH_ESCAPES refuses connect by name', async () => {
    const { drizzle } = await import('drizzle-orm/mysql2');
    const { withReplicas } = await import('drizzle-orm/mysql-core');
    const { createDrizzleDatabase, DrizzleAdapter, DatabaseService, UnsupportedSqlModeError } =
      await import('../../src/index.ts');
    const { mysqlTables } = await import('../fixtures/mysql-tables.ts');
    const h = await mysqlHarness('drizzle', 4);
    const replicaConnection = await h.pool.getConnection();
    try {
      const repo = h.database.getRepository<Record<string, unknown>>('Row');
      for (const id of ['a', 'b']) await repo.create({ id, name: id, version: 1, balance: 1 });
      const [settings] = await replicaConnection.query<RowDataPacket[]>(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      const original = String(settings[0]!.mode);
      await replicaConnection.query('SET SESSION sql_mode = ?', [
        `${original},NO_BACKSLASH_ESCAPES`,
      ]);
      try {
        const primary = drizzle(h.pool);
        // A replica on its own pinned connection; Drizzle types replicas like the primary.
        const replica = drizzle(replicaConnection) as unknown as typeof primary;
        const adapter = new DrizzleAdapter({
          drizzleInstance: createDrizzleDatabase(withReplicas(primary, [replica]), (db, work) =>
            db.transaction(work),
          ),
          drizzleTables: mysqlTables,
          dialect: 'mysql',
        });
        const refusal = await adapter.connect().then(
          async () => {
            // Without the replica read, a select through the replica breaks out of its literal.
            const db = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'drizzle');
            const rows = await db.getRepository<Record<string, unknown>>('Row').findAll({
              filter: { type: 'comparison', field: ['id'], operator: 'eq', value: "' OR 1=1 -- " },
            });
            await db.close();
            return rows;
          },
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(UnsupportedSqlModeError);
      } finally {
        await replicaConnection.query('SET SESSION sql_mode = ?', [original]);
      }
    } finally {
      replicaConnection.release();
      await h.dispose();
    }
  });
});

/**
 * Changes @@GLOBAL.sql_mode for every client of the server, so it runs only on
 * an explicit opt-in (MYSQL_GLOBAL_MODE=1) beside MYSQL_URL, and restores it.
 */
describe(
  'Drizzle real MySQL pool connections opened under a global NO_BACKSLASH_ESCAPES',
  { skip: !process.env['MYSQL_URL'] || process.env['MYSQL_GLOBAL_MODE'] !== '1' },
  () => {
    it('lands the injection on an unguarded new connection; the guard strips it, then refuses by name with one warn', async () => {
      const { createConnection, createPool } = await import('mysql2/promise');
      const { drizzle } = await import('drizzle-orm/mysql2');
      const { eq } = await import('drizzle-orm');
      const { createDrizzleDatabase, DrizzleAdapter, DatabaseService, UnsupportedSqlModeError } =
        await import('../../src/index.ts');
      const { mysqlTables } = await import('../fixtures/mysql-tables.ts');
      const h = await mysqlHarness('drizzle', 4);
      const endpoint = new URL(process.env['MYSQL_URL']!);
      const options = {
        host: endpoint.hostname,
        port: Number(endpoint.port || 3306),
        user: decodeURIComponent(endpoint.username),
        password: decodeURIComponent(endpoint.password),
        database: h.name,
      };
      const admin = await createConnection(options);
      const [saved] = await admin.query<RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode');
      const original = String(saved[0]!.mode);
      const payload = "' OR 1=1 -- ";
      try {
        const repo = h.database.getRepository<Record<string, unknown>>('Row');
        for (const id of ['a', 'b']) await repo.create({ id, name: id, version: 1, balance: 1 });

        // Guarded pool, checked under the default mode; its one connection is then held,
        // so the repository's next statement runs on a connection opened under the mode.
        const guardedPool = createPool({ ...options, connectionLimit: 4 });
        const warnings: string[] = [];
        const adapter = new DrizzleAdapter(
          {
            drizzleInstance: createDrizzleDatabase(drizzle(guardedPool), (db, work) =>
              db.transaction(work),
            ),
            drizzleTables: mysqlTables,
            dialect: 'mysql',
          },
          (message) => warnings.push(message),
        );
        await adapter.connect();
        const held = await guardedPool.getConnection();
        const controlPool = createPool({ ...options, connectionLimit: 1 });
        const db = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'drizzle');
        try {
          await admin.query('SET GLOBAL sql_mode = ?', [`${original},NO_BACKSLASH_ESCAPES`]);
          // Negative control: the first statement on a new unguarded pooled connection.
          const injected = await drizzle(controlPool)
            .select()
            .from(mysqlTables.Row)
            .where(eq(mysqlTables.Row.id, payload));
          expect(injected.map((row) => row.id).sort()).toEqual(['a', 'b']);

          const guardedRepo = db.getRepository<Record<string, unknown>>('Row');
          const findPayload = () =>
            guardedRepo.findAll({
              filter: { type: 'comparison', field: ['id'], operator: 'eq', value: payload },
            });
          expect(await findPayload()).toEqual([]);
          await expect(findPayload()).rejects.toBeInstanceOf(UnsupportedSqlModeError);
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain('NO_BACKSLASH_ESCAPES');
        } finally {
          await admin.query('SET GLOBAL sql_mode = ?', [original]);
          held.release();
          await db.close();
          await guardedPool.end();
          await controlPool.end();
        }
      } finally {
        const [after] = await admin.query<RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode');
        expect(String(after[0]!.mode)).toBe(original);
        await admin.end();
        await h.dispose();
      }
    });
  },
);
