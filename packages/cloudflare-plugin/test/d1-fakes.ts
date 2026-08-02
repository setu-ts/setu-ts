/**
 * D1 test doubles.
 *
 * {@linkcode SqliteD1} implements the `ID1Database` facade over a **real**
 * SQLite engine (`node:sqlite`), which is the engine D1 itself runs. That
 * matters: a scripted fake would happily accept malformed SQL and return
 * whatever it was told to, so it can only prove the adapter called it — never
 * that the generated statement is valid, that `RETURNING *` actually yields
 * the persisted row, or that a batch rolls back. Driving real SQLite proves
 * all three.
 *
 * {@linkcode RecordingD1} is the complement: it stores nothing and records
 * every call, for assertions about what was sent rather than what came back.
 *
 * @module
 */

import { DatabaseSync } from 'node:sqlite';

import type { D1Result, ID1Database, ID1PreparedStatement } from '../src/index.ts';

/** A statement as it was handed to the binding. */
export interface RecordedStatement {
  /** The SQL text. */
  readonly sql: string;
  /** The bound parameters, in positional order. */
  readonly params: readonly unknown[];
}

/** SQLite returns null-prototype rows; D1 returns ordinary JSON objects. */
function toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

/**
 * A prepared statement over real SQLite.
 *
 * `bind()` returns a NEW statement rather than mutating, matching the real
 * binding, where `db.prepare(q).bind(a)` and `.bind(b)` are independent.
 */
class SqliteStatement implements ID1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: readonly unknown[],
    private readonly onExecute: (statement: RecordedStatement) => void,
  ) {}

  bind(...values: readonly unknown[]): ID1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, values, this.onExecute);
  }

  /**
   * Execute synchronously. SQLite is a synchronous engine, so this is the real
   * work; the async members below just wrap it. `batch()` needs the sync form
   * to keep every statement inside one open transaction.
   *
   * @returns The result rows
   */
  execSync<T = Record<string, unknown>>(): D1Result<T> {
    this.onExecute({ sql: this.sql, params: this.params });
    const rows = this.db.prepare(this.sql).all(...(this.params as never[]));
    return {
      results: rows.map((r) => toPlainRow(r as Record<string, unknown>)) as T[],
      success: true,
    };
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve(this.execSync<T>());
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.all<T>();
    return result.results[0] ?? null;
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }
}

/**
 * `ID1Database` over an in-memory SQLite database.
 *
 * @example
 * ```typescript
 * const db = new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
 * ```
 */
export class SqliteD1 implements ID1Database {
  readonly #db: DatabaseSync;
  /** Every statement executed, in order — including those run inside a batch. */
  readonly executed: RecordedStatement[] = [];
  /** One entry per `batch()` call, holding that batch's statements. */
  readonly batches: RecordedStatement[][] = [];

  /**
   * @param schema - DDL statements to run before any test code
   */
  constructor(...schema: readonly string[]) {
    this.#db = new DatabaseSync(':memory:');
    for (const ddl of schema) this.#db.exec(ddl);
  }

  prepare(query: string): ID1PreparedStatement {
    return new SqliteStatement(this.#db, query, [], (s) => this.executed.push(s));
  }

  /**
   * Run every statement as one transaction, rolling the whole sequence back if
   * any of them fails — the behaviour Cloudflare documents for `batch()`.
   */
  batch<T = Record<string, unknown>>(
    statements: readonly ID1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const before = this.executed.length;

    this.#db.exec('BEGIN');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement)) {
          throw new TypeError('SqliteD1.batch received a statement it did not prepare');
        }
        return statement.execSync<T>();
      });
      this.#db.exec('COMMIT');
      this.batches.push(this.executed.slice(before));
      return Promise.resolve(results);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      this.batches.push(this.executed.slice(before));
      return Promise.reject(error);
    }
  }

  /**
   * Read a table directly, bypassing the adapter — so a test can assert what
   * was actually persisted rather than trusting the path under test.
   *
   * @param table - The table to dump
   * @returns Every row, as plain objects
   */
  dump(table: string): Record<string, unknown>[] {
    return this.#db.prepare(`SELECT * FROM "${table}"`).all().map(
      (r) => toPlainRow(r as Record<string, unknown>),
    );
  }
}

/**
 * `ID1Database` that persists nothing and records everything.
 *
 * Use it to assert what the adapter SENT — statement text, bind order, batch
 * grouping — where {@linkcode SqliteD1} proves what comes back.
 */
export class RecordingD1 implements ID1Database {
  /** Every statement executed, in order. */
  readonly executed: RecordedStatement[] = [];
  /** One entry per `batch()` call. */
  readonly batches: RecordedStatement[][] = [];
  /** Rows the next `all()`/`first()` should return, keyed by SQL prefix. */
  #scripted: readonly Record<string, unknown>[] = [];

  /**
   * Script the rows every subsequent read returns.
   *
   * @param rows - The rows to return
   */
  returns(rows: readonly Record<string, unknown>[]): void {
    this.#scripted = rows;
  }

  prepare(query: string): ID1PreparedStatement {
    // Arrow functions capture `this` lexically, so no alias is needed.
    const make = (params: readonly unknown[]): ID1PreparedStatement => ({
      bind: (...values: readonly unknown[]) => make(values),
      all: <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        this.executed.push({ sql: query, params });
        return Promise.resolve({ results: this.#scripted as T[], success: true });
      },
      first: <T = Record<string, unknown>>(): Promise<T | null> => {
        this.executed.push({ sql: query, params });
        return Promise.resolve((this.#scripted[0] as T) ?? null);
      },
      run: <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        this.executed.push({ sql: query, params });
        return Promise.resolve({ results: [] as T[], success: true });
      },
    });
    return make([]);
  }

  batch<T = Record<string, unknown>>(
    statements: readonly ID1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const before = this.executed.length;
    return Promise.all(statements.map((s) => s.all<T>())).then((results) => {
      this.batches.push(this.executed.slice(before));
      return results;
    });
  }
}
