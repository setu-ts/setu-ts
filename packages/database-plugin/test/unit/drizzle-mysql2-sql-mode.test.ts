/**
 * Drizzle over mysql2 refuses `NO_BACKSLASH_ESCAPES` at connect and once a
 * connection the pool opens later reports it. The pool, its connections and
 * their answers are fakes; the real-server cells are in
 * `real-drizzle-mysql.test.ts`.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { entityKind } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { createDrizzleDatabase, DrizzleAdapter, UnsupportedSqlModeError } from '../../src/index.ts';
import {
  guardMysql2Pool,
  hasNoBackslashEscapes,
  isMysql2Database,
  READ_SESSION_MODE,
  sessionModeOf,
  STRIP_SESSION_MODE,
} from '../../src/adapters/drizzle/mysql2-escape-guard.ts';
import {
  DRIZZLE_QUERY_HANDLE,
  type DrizzleQueryHandleProvider,
} from '../../src/query/drizzle-query.ts';
import { mysqlTables } from '../fixtures/mysql-tables.ts';

const DEFAULT_MODE = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
const REFUSED_MODE = `${DEFAULT_MODE},NO_BACKSLASH_ESCAPES`;

/** A promise-style mysql2 pool: `query` answers the session mode, `getConnection` a transaction client. */
class FakePool extends EventEmitter {
  mode: string | undefined = DEFAULT_MODE;
  failure: Error | undefined;
  readonly statements: string[] = [];

  query(statement: string | { sql: string }): Promise<unknown> {
    const text = typeof statement === 'string' ? statement : statement.sql;
    this.statements.push(text);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(text === READ_SESSION_MODE ? [[{ mode: this.mode }], []] : [[], []]);
  }

  getConnection(): Promise<{ query: FakePool['query']; release(): void }> {
    return Promise.resolve({ query: (statement) => this.query(statement), release: () => {} });
  }
}

/** A callback-style connection as the pool emits it with `'connection'`. */
function newConnection(answer: { mode?: string; readError?: Error; stripError?: Error }) {
  const statements: string[] = [];
  return {
    statements,
    destroy: vi.fn(),
    query(sql: string, callback: (error: unknown, rows?: unknown) => void): void {
      statements.push(sql);
      if (sql === READ_SESSION_MODE) callback(answer.readError ?? null, [{ mode: answer.mode }]);
      else callback(answer.stripError ?? null, {});
    },
  };
}

function adapterOver(client: object, warn?: (message: string) => void): DrizzleAdapter {
  return new DrizzleAdapter(
    {
      drizzleInstance: createDrizzleDatabase(drizzle(client as never), (db, work) =>
        db.transaction(work),
      ),
      drizzleTables: mysqlTables,
      dialect: 'mysql',
    },
    warn,
  );
}

describe('Drizzle over mysql2 and NO_BACKSLASH_ESCAPES', () => {
  it('connects under the default mode, reading it once, and guards the pool until disconnect', async () => {
    const pool = new FakePool();
    const adapter = adapterOver(pool);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    expect(pool.statements).toEqual([READ_SESSION_MODE]);
    expect(pool.listenerCount('connection')).toBe(1);
    await adapter.connect();
    expect(pool.listenerCount('connection')).toBe(1);
    await adapter.disconnect();
    expect(pool.listenerCount('connection')).toBe(0);
  });

  it('refuses at connect by name when the session reports the mode, and leaves no guard behind', async () => {
    const pool = new FakePool();
    pool.mode = REFUSED_MODE;
    const adapter = adapterOver(pool);
    const refusal = await adapter.connect().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnsupportedSqlModeError);
    expect(refusal).toMatchObject({
      name: 'UnsupportedSqlModeError',
      mode: 'NO_BACKSLASH_ESCAPES',
    });
    expect((refusal as Error).message).toContain('sql_mode includes NO_BACKSLASH_ESCAPES');
    expect((refusal as Error).message).toContain('init_connect');
    expect((refusal as Error).message).toContain('sidorares/node-mysql2#4684');
    expect(adapter.isReady()).toBe(false);
    expect(pool.listenerCount('connection')).toBe(0);
  });

  it('refuses at connect when the mode cannot be read, and propagates a failed read', async () => {
    const unreadable = new FakePool();
    unreadable.mode = undefined;
    await expect(adapterOver(unreadable).connect()).rejects.toThrow(
      /could not read @@SESSION\.sql_mode/,
    );
    expect(unreadable.listenerCount('connection')).toBe(0);
    const down = new FakePool();
    down.failure = new Error('connect ECONNREFUSED');
    await expect(adapterOver(down).connect()).rejects.toMatchObject({ cause: down.failure });
    expect(down.listenerCount('connection')).toBe(0);
  });

  it('checks a plain connection at connect only, and refuses one that reports the mode', async () => {
    const connection = {
      statements: [] as string[],
      mode: DEFAULT_MODE,
      query(statement: { sql: string }): Promise<unknown> {
        this.statements.push(statement.sql);
        return Promise.resolve([[{ mode: this.mode }], []]);
      },
    };
    const adapter = adapterOver(connection);
    await adapter.connect();
    expect(connection.statements).toEqual([READ_SESSION_MODE]);
    await adapter.disconnect();
    connection.mode = REFUSED_MODE;
    await expect(adapterOver(connection).connect()).rejects.toBeInstanceOf(UnsupportedSqlModeError);
  });

  it('refuses every later call, warning once, after a connection the pool opened later reports the mode', async () => {
    const pool = new FakePool();
    const warn = vi.fn();
    const adapter = adapterOver(pool, warn);
    await adapter.connect();
    const source = adapter.createDataSource('Row');
    const transaction = await adapter.beginTransaction();
    const inTransaction = transaction.createDataSource('Row');

    const later = newConnection({ mode: REFUSED_MODE });
    pool.emit('connection', later);
    // The strip is queued behind the read, so both precede the pool caller's statement.
    expect(later.statements).toEqual([READ_SESSION_MODE, STRIP_SESSION_MODE]);
    expect(later.destroy).not.toHaveBeenCalled();
    pool.emit('connection', newConnection({ mode: REFUSED_MODE }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('UnsupportedSqlModeError');

    await expect(source.findById('a')).rejects.toBeInstanceOf(UnsupportedSqlModeError);
    await expect(inTransaction.findById('a')).rejects.toBeInstanceOf(UnsupportedSqlModeError);
    expect(() => adapter.createDataSource('Row')).toThrow(UnsupportedSqlModeError);
    await expect(adapter.rawQuery('SELECT 1')).rejects.toBeInstanceOf(UnsupportedSqlModeError);
    await expect(adapter.beginTransaction()).rejects.toBeInstanceOf(UnsupportedSqlModeError);
    expect(() =>
      (adapter as unknown as DrizzleQueryHandleProvider)[DRIZZLE_QUERY_HANDLE](),
    ).toThrow(UnsupportedSqlModeError);
    expect(() =>
      (transaction as unknown as DrizzleQueryHandleProvider)[DRIZZLE_QUERY_HANDLE](),
    ).toThrow(UnsupportedSqlModeError);
    expect(await adapter.isHealthy!()).toBe(false);
    await transaction.rollback();
    await adapter.disconnect();
  });

  it('keeps serving after a later connection under the default mode, a failed read, or a refused strip', async () => {
    const pool = new FakePool();
    const adapter = adapterOver(pool);
    await adapter.connect();
    pool.emit('connection', newConnection({ mode: DEFAULT_MODE }));
    pool.emit('connection', newConnection({ readError: new Error('read failed') }));
    const refusedStrip = newConnection({ mode: DEFAULT_MODE, stripError: new Error('denied') });
    pool.emit('connection', refusedStrip);
    expect(refusedStrip.destroy).toHaveBeenCalledTimes(1);
    await expect(adapter.rawQuery('SELECT 1')).resolves.toBeDefined();
    expect(() => adapter.createDataSource('Row')).not.toThrow();
    await adapter.disconnect();
  });
});

describe('mysql2 escape-guard helpers', () => {
  it('detects only a MySql2Database by its entityKind brand', () => {
    class MySql2Database {
      static readonly [entityKind] = 'MySql2Database';
    }
    class PgDatabase {
      static readonly [entityKind] = 'PgDatabase';
    }
    expect(isMysql2Database(new MySql2Database(), entityKind)).toBe(true);
    expect(isMysql2Database(new PgDatabase(), entityKind)).toBe(false);
    expect(isMysql2Database(new MySql2Database(), undefined)).toBe(false);
    expect(isMysql2Database(null, entityKind)).toBe(false);
  });

  it('reads the flag from a sql_mode list, ignoring case and spacing', () => {
    expect(hasNoBackslashEscapes(REFUSED_MODE)).toBe(true);
    expect(hasNoBackslashEscapes(' no_backslash_escapes ')).toBe(true);
    expect(hasNoBackslashEscapes(DEFAULT_MODE)).toBe(false);
    expect(hasNoBackslashEscapes('')).toBe(false);
  });

  it('reads the mode from execute() and callback result shapes only', () => {
    expect(sessionModeOf([[{ mode: 'A' }], []])).toBe('A');
    expect(sessionModeOf([{ mode: 'B' }])).toBe('B');
    expect(sessionModeOf([])).toBeUndefined();
    expect(sessionModeOf([{ mode: 7 }])).toBeUndefined();
    expect(sessionModeOf({ affectedRows: 0 })).toBeUndefined();
  });

  it('attaches no guard to a client that is not an event-emitting pool', () => {
    const onRefused = vi.fn();
    expect(guardMysql2Pool(undefined, onRefused)).toBeUndefined();
    expect(guardMysql2Pool({ query() {} }, onRefused)).toBeUndefined();
    expect(guardMysql2Pool({ getConnection() {}, on() {} }, onRefused)).toBeUndefined();
  });
});
