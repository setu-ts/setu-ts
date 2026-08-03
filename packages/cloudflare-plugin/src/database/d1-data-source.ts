/**
 * The two {@linkcode IDataSource} implementations over a D1 binding.
 *
 * `createD1DataSource` runs each operation immediately. `D1TransactionBuffer`
 * defers writes so they can be flushed as one `batch()`, which is D1's only
 * unit of atomicity — see the transaction discussion on
 * {@linkcode D1Adapter}.
 *
 * @module
 */

import type { IDataSource, NormalizedQuery } from '@hono-enterprise/common';
import type { ID1Database, ID1PreparedStatement } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import type { D1Statement, D1Target } from './d1-sql.ts';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildSelectById,
  buildUpdate,
  D1_COUNT_ALIAS,
} from './d1-sql.ts';

/**
 * Prepare and bind a built statement against the binding.
 *
 * `bind()` is called with no arguments for a parameterless statement rather
 * than being skipped, so every path returns a bound statement and callers
 * never branch on it.
 *
 * @param db - The D1 binding
 * @param statement - The built SQL and its parameters
 * @returns The prepared, bound statement
 */
export function prepareStatement(db: ID1Database, statement: D1Statement): ID1PreparedStatement {
  return db.prepare(statement.sql).bind(...statement.params);
}

/**
 * Read the aggregate produced by {@linkcode buildCount}.
 *
 * @param row - The single row `COUNT(*)` returns
 * @returns The count, or `0` when the row is absent
 */
function readCount(row: Record<string, unknown> | null): number {
  const value = row?.[D1_COUNT_ALIAS];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Build a data source that executes every operation immediately against the
 * binding.
 *
 * @param db - The D1 binding
 * @param target - The table and primary key this source addresses
 * @returns A data source for that entity
 */
export function createD1DataSource(db: ID1Database, target: D1Target): IDataSource {
  return {
    async findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]> {
      const result = await prepareStatement(db, buildSelect(target, query)).all();
      return [...result.results];
    },

    findById(id: string | number): Promise<Record<string, unknown> | null> {
      return prepareStatement(db, buildSelectById(target, id)).first();
    },

    async create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const row = await prepareStatement(db, buildInsert(target, data)).first();
      if (row === null) {
        throw new Error(
          `D1: insert into '${target.table}' returned no row. ` +
            'The table may be missing, or a trigger may have suppressed the insert.',
        );
      }
      return row;
    },

    async update(
      id: string | number,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      const row = await prepareStatement(db, buildUpdate(target, id, data)).first();
      if (row === null) {
        throw new Error(`Entity '${target.table}' with id '${id}' not found`);
      }
      return row;
    },

    async delete(id: string | number): Promise<boolean> {
      const result = await prepareStatement(db, buildDelete(target, id)).all();
      return result.results.length > 0;
    },

    async count(where: Record<string, unknown>): Promise<number> {
      const row = await prepareStatement(db, buildCount(target, where)).first();
      return readCount(row);
    },
  };
}

/**
 * Collects the writes made inside one transaction so they can be flushed as a
 * single `batch()`.
 *
 * Shared by every data source opened from the same transaction handle, which
 * is what makes a Unit of Work spanning several entities atomic.
 *
 * @since 0.2.0
 */
export class D1TransactionBuffer {
  readonly #statements: D1Statement[] = [];
  #finalized = false;

  /**
   * Buffer one statement.
   *
   * @param statement - The built statement to apply at commit
   * @throws {Error} When the transaction has already been committed or rolled back
   */
  add(statement: D1Statement): void {
    this.assertOpen();
    this.#statements.push(statement);
  }

  /**
   * Refuse any further use of a finalized transaction.
   *
   * @throws {Error} When already committed or rolled back
   */
  assertOpen(): void {
    if (this.#finalized) {
      throw new Error('Transaction already finalized');
    }
  }

  /** Mark the transaction finalized, so a second commit or rollback throws. */
  finalize(): void {
    this.#finalized = true;
  }

  /**
   * Hand over every buffered statement in insertion order.
   *
   * @returns The buffered statements
   */
  drain(): readonly D1Statement[] {
    return [...this.#statements];
  }
}

/**
 * Build a data source whose reads run immediately but whose writes are
 * buffered into `buffer` for the transaction's single `batch()`.
 *
 * Reads therefore observe **committed** state and never the transaction's own
 * pending writes. `update` and `delete` still read first, so both can honor
 * their committed return contracts (`update` throws when the row is missing;
 * `delete` reports whether anything matched) — the value they report reflects
 * committed state at call time, consistent with every other read here.
 *
 * @param db - The D1 binding
 * @param target - The table and primary key this source addresses
 * @param buffer - The shared statement buffer for this transaction
 * @returns A transaction-scoped data source
 */
export function createD1TransactionDataSource(
  db: ID1Database,
  target: D1Target,
  buffer: D1TransactionBuffer,
): IDataSource {
  const committed = createD1DataSource(db, target);

  // Every member is `async` so a refusal REJECTS rather than throwing
  // synchronously. The declared return type is a promise, and a caller using
  // `.catch()` instead of `await` must not be bypassed.
  return {
    async findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]> {
      buffer.assertOpen();
      return await committed.findAll(query);
    },

    async findById(id: string | number): Promise<Record<string, unknown> | null> {
      buffer.assertOpen();
      return await committed.findById(id);
    },

    // deno-lint-ignore require-await -- must reject, not throw synchronously
    async create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
      buffer.assertOpen();
      // A deferred INSERT cannot report a generated key back to a caller that
      // awaits create() before the flush. Rather than return a row whose id is
      // missing, or invent a client-side value that would be the wrong type for
      // an INTEGER key, refuse and name the constraint.
      if (data[target.primaryKey] === undefined) {
        throw new CloudflareUnsupportedError(
          `D1: create() inside a transaction requires an explicit ` +
            `'${target.primaryKey}' for '${target.table}'. D1 has no interactive ` +
            'transaction, so writes are buffered and flushed as one batch() at commit, ' +
            'and a generated key is not known until then. Supply the key, or create ' +
            'outside the transaction where RETURNING * provides it.',
        );
      }
      buffer.add(buildInsert(target, data));
      return { ...data } as Record<string, unknown>;
    },

    async update(
      id: string | number,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      buffer.assertOpen();
      const current = await committed.findById(id);
      if (current === null) {
        throw new Error(`Entity '${target.table}' with id '${id}' not found`);
      }
      buffer.add(buildUpdate(target, id, data));
      return { ...current, ...data };
    },

    async delete(id: string | number): Promise<boolean> {
      buffer.assertOpen();
      const current = await committed.findById(id);
      if (current === null) return false;
      buffer.add(buildDelete(target, id));
      return true;
    },

    async count(where: Record<string, unknown>): Promise<number> {
      buffer.assertOpen();
      return await committed.count(where);
    },
  };
}
