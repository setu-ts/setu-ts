/**
 * Drizzle over mysql2 refuses `NO_BACKSLASH_ESCAPES` at connect and once a
 * connection the pool opens later reports it. The pool, its connections and
 * their answers are fakes; the real-server cells are in
 * `real-drizzle-mysql.test.ts`.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError, entityKind } from 'drizzle-orm';
import { withReplicas } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { createDrizzleDatabase, DrizzleAdapter, UnsupportedSqlModeError } from '../../src/index.ts';
import {
  guardMysql2Pool,
  hasNoBackslashEscapes,
  isMysql2Database,
  mysql2Targets,
  READ_SESSION_MODE,
  READ_SESSION_MODE_TIMEOUT_MS,
  readSessionModeWithin,
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
    expect(refusal).not.toHaveProperty('unreadReason');
    expect(adapter.isReady()).toBe(false);
    expect(pool.listenerCount('connection')).toBe(0);
  });

  it('refuses at connect when the mode cannot be read, and propagates a failed read', async () => {
    const unreadable = new FakePool();
    unreadable.mode = undefined;
    const unread = await adapterOver(unreadable)
      .connect()
      .catch((error: unknown) => error);
    expect(unread).toBeInstanceOf(UnsupportedSqlModeError);
    expect((unread as Error).message).toMatch(
      /could not read @@SESSION\.sql_mode \(the result held no sql_mode\)/,
    );
    expect(unread).toMatchObject({ unreadReason: 'the result held no sql_mode' });
    expect((unread as Error).message).toMatch(
      /Start the application once MySQL answers, or retry connect\(\)/,
    );
    expect((unread as Error).message).not.toContain('Turn NO_BACKSLASH_ESCAPES off');
    expect(unreadable.listenerCount('connection')).toBe(0);
    const down = new FakePool();
    down.failure = new Error('connect ECONNREFUSED');
    const failed = await adapterOver(down)
      .connect()
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(UnsupportedSqlModeError);
    expect(failed).toMatchObject({ unreadReason: 'the read failed' });
    expect((failed as Error).cause).toBeInstanceOf(DrizzleQueryError);
    expect(((failed as Error).cause as Error).cause).toBe(down.failure);
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

  it('reads and guards the primary and every replica of a withReplicas() instance', async () => {
    const primary = new FakePool();
    const replica = new FakePool();
    const db = withReplicas(drizzle(primary as never), [
      drizzle(replica as never),
      drizzle(primary as never),
    ]);
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(db, (d, work) => d.transaction(work)),
      drizzleTables: mysqlTables,
      dialect: 'mysql',
    });
    await adapter.connect();
    expect(primary.statements).toEqual([READ_SESSION_MODE, READ_SESSION_MODE]);
    expect(replica.statements).toEqual([READ_SESSION_MODE]);
    expect([primary.listenerCount('connection'), replica.listenerCount('connection')]).toEqual([
      1, 1,
    ]);
    await adapter.disconnect();
    expect(replica.listenerCount('connection')).toBe(0);

    replica.mode = REFUSED_MODE;
    await expect(adapter.connect()).rejects.toBeInstanceOf(UnsupportedSqlModeError);
    expect([primary.listenerCount('connection'), replica.listenerCount('connection')]).toEqual([
      0, 0,
    ]);
    replica.mode = DEFAULT_MODE;
    const later = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(db, (d, work) => d.transaction(work)),
      drizzleTables: mysqlTables,
      dialect: 'mysql',
    });
    await later.connect();
    replica.emit('connection', newConnection({ mode: REFUSED_MODE }));
    expect(() => later.createDataSource('Row')).toThrow(UnsupportedSqlModeError);
    await later.disconnect();
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
  it('detects mysql2 by the session brand, which a withReplicas() wrapper carries', () => {
    const pool = new FakePool();
    const db = drizzle(pool as never);
    expect(isMysql2Database(db, entityKind)).toBe(true);
    expect(isMysql2Database(withReplicas(db, [db]), entityKind)).toBe(true);
    expect(isMysql2Database({ session: {} }, entityKind)).toBe(false);
    expect(isMysql2Database(db, undefined)).toBe(false);
    expect(isMysql2Database(null, entityKind)).toBe(false);
    expect(mysql2Targets({ session: {} }, entityKind)).toEqual([]);
    expect(mysql2Targets(db, entityKind)).toEqual([db]);
    // A replica on another driver is not read.
    const other = { execute: () => Promise.resolve([]) };
    expect(mysql2Targets({ ...db, $primary: db, $replicas: [other] }, entityKind)).toEqual([db]);
  });

  it('reads every mysql2 member of a nested replicas wrapper', () => {
    const [m2, r1, r1b] = [0, 1, 2].map(() => drizzle(new FakePool() as never));
    const nested = withReplicas(m2!, [withReplicas(r1!, [r1b!])]);
    expect(mysql2Targets(nested, entityKind)).toEqual([m2, r1, r1b]);
  });

  it('reads the mysql2 replicas behind a primary on another driver', () => {
    const [r1, r2] = [0, 1].map(() => drizzle(new FakePool() as never));
    const proxy = { session: {}, execute: () => Promise.resolve([]) };
    const mixed = { ...proxy, $primary: proxy, $replicas: [r1, r2] };
    expect(mysql2Targets(mixed, entityKind)).toEqual([r1, r2]);
    // Malformed, but with nothing on mysql2 to guard.
    expect(mysql2Targets({ ...proxy, $primary: proxy }, entityKind)).toEqual([]);
    // Malformed, with a mysql2 member.
    expect(() => mysql2Targets({ ...proxy, $primary: r1 }, entityKind)).toThrow(
      UnsupportedSqlModeError,
    );
  });

  it('refuses a mysql2 replicas wrapper whose members cannot all be read', () => {
    const db = drizzle(new FakePool() as never);
    for (const wrapper of [
      { ...db, $primary: db },
      { ...db, $replicas: [db] },
      { ...db, $primary: db, $replicas: [{}] },
    ]) {
      expect(() => mysql2Targets(wrapper, entityKind)).toThrow(UnsupportedSqlModeError);
    }
  });

  it('bounds a sql_mode read and names the expiry as the cause', async () => {
    expect(READ_SESSION_MODE_TIMEOUT_MS).toBe(2000);
    const stalled = { execute: () => new Promise<unknown>(() => {}) };
    const expired = await readSessionModeWithin(stalled, 'statement', 5).catch(
      (error: unknown) => error,
    );
    expect(expired).toBeInstanceOf(UnsupportedSqlModeError);
    expect((expired as Error).cause).toMatchObject({ message: 'no answer within 5 ms' });
    expect(
      await readSessionModeWithin(
        { execute: () => Promise.resolve([[{ mode: DEFAULT_MODE }], []]) },
        'statement',
        5,
      ),
    ).toBe(DEFAULT_MODE);
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
