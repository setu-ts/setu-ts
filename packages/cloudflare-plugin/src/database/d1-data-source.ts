import { InvalidFieldValueError, UnknownPayloadFieldError } from '@setu-ts/common';
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
import { assertPrimaryKeyUnchanged, InvalidCursorError } from '@setu-ts/common';

import type {
  CursorPayload,
  EntityKey,
  FilterExpression,
  IDataSource,
  NormalizedQuery,
  PageResult,
} from '@setu-ts/common';
import {
  checkWritePrecondition,
  decodeCursor,
  keysetPredicate,
  mintNextCursor,
  resolveKeysetSort,
  sortFingerprint,
} from '@setu-ts/common';
import type { ID1Database, ID1PreparedStatement } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import type { D1Statement, D1Target } from './d1-sql.ts';
import {
  buildCount,
  buildDelete,
  buildDeleteWhere,
  buildInsert,
  buildSelect,
  buildSelectById,
  buildUpdate,
  buildUpdateWhere,
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
 * The one keyset-paging pipeline every D1 data source shares.
 *
 * The pipeline is §3.8 — decode the incoming cursor (rejecting a malformed
 * token or a sort-fingerprint mismatch by name, never a synchronous throw),
 * build the portable keyset predicate with the shared {@linkcode keysetPredicate}
 * from `common`, conjoin it with the caller's own `filter`, fetch `limit + 1`
 * rows (the one-extra-row probe), and mint the next cursor from the LAST
 * returned row with the shared {@linkcode mintNextCursor}. `nextCursor` is
 * `null` precisely when the probe returned no more than `limit` rows, so the
 * last page is indistinguishable from a full one only by the probe count.
 *
 * The cursor payload, predicate, fingerprint and minting all come from
 * `@setu-ts/common`, so D1's walk is byte-identical to the four
 * database-plugin adapters' — a cursor minted by one and presented to the
 * other cannot drift, because there is exactly one implementation.
 *
 * When a projection is active the key columns and the ordered fields the minting
 * reads are added to the internal `SELECT` so they participate in the probe and
 * are available to the minting; they are stripped from the returned rows so the
 * caller's projection is what comes back (§8 risk).
 *
 * @param db - The D1 binding
 * @param target - The table and primary key this source addresses
 * @param query - The normalized page query, carrying an incoming `cursor`
 * @returns A {@linkcode PageResult} carrying `rows` and the `nextCursor`
 */
async function findD1Page(
  db: ID1Database,
  target: D1Target,
  query: NormalizedQuery,
): Promise<PageResult> {
  // §3.10 — offset and cursor are contradictory; refuse before any call.
  if (query.offset !== 0 && query.cursor !== undefined) {
    return Promise.reject(
      new CloudflareUnsupportedError(
        `D1: offset=${query.offset} conflicts with cursor; use one or the other`,
      ),
    );
  }

  // 1. Decode cursor. A missing cursor means start of the walk; a malformed
  //    token is refused by name.
  let decoded: CursorPayload | null = null;
  if (query.cursor !== undefined) {
    decoded = decodeCursor(query.cursor);
    if (decoded === null) {
      return Promise.reject(
        new InvalidCursorError(`Entity '${target.table}': malformed cursor token.`),
      );
    }
  }

  // 2. Sort-fingerprint guard — a cross-sort cursor would return a silently
  //    wrong page.
  const fingerprint = sortFingerprint(query.orderBy, {
    entity: target.entity,
    keyColumns: target.primaryKey,
  });
  if (decoded !== null && decoded.sortFingerprint !== fingerprint) {
    return Promise.reject(
      new InvalidCursorError(`Entity '${target.table}': cursor fingerprint mismatch.`),
    );
  }
  if (
    decoded !== null &&
    (decoded.keyValues.length !== target.primaryKey.length ||
      decoded.orderedValues.length !== Object.keys(query.orderBy).length)
  ) {
    return Promise.reject(
      new InvalidCursorError(`Entity '${target.table}': cursor key shape mismatch.`),
    );
  }

  // 3. Keyset predicate through the shared builder; conjoin it with the
  //    caller's own filter. buildWhere already joins query.filter with
  //    query.where, so injecting the keyset predicate into query.filter
  //    yields the full WHERE with one AND leg per source.
  // ORDER BY must use the RESOLVED sort, not the caller's `orderBy`: the
  // keyset comparison is expanded over `orderBy` + the key columns, so
  // sorting by `orderBy` alone leaves tied rows in an order the backend
  // picks freely and the predicate skips or repeats them.
  const keysetSort = resolveKeysetSort(query.orderBy, target.primaryKey);
  const keyset =
    decoded === null
      ? undefined
      : keysetPredicate(decoded.orderedValues, decoded.keyValues, query.orderBy, target.primaryKey);
  const filter: FilterExpression | undefined =
    keyset !== undefined && query.filter !== undefined
      ? { type: 'and', filters: [query.filter, keyset] }
      : (keyset ?? query.filter);

  // 4. The caller's projection is augmented with the key columns and the
  //    ordered fields the minting reads, so they participate in the probe and
  //    are available to mintNextCursor; they are stripped from the returned
  //    rows. An empty select keeps today's `*` path.
  const effectiveSelect =
    query.select.length === 0
      ? []
      : [...new Set([...query.select, ...target.primaryKey, ...Object.keys(query.orderBy)])];
  const probeQuery: NormalizedQuery = {
    ...query,
    orderBy: keysetSort,
    select: effectiveSelect,
    limit: query.limit > 0 ? query.limit + 1 : query.limit,
    ...(filter === undefined ? {} : { filter }),
  };
  const result = await prepareStatement(db, buildSelect(target, probeQuery)).all();
  const allRows = [...result.results];

  // 5. Probe outcome: more than `limit` rows means a next page exists and the
  //    LAST returned row mints the cursor; otherwise the page is terminal.
  const hasMore = query.limit > 0 && allRows.length > query.limit;
  const pageRows = hasMore ? allRows.slice(0, query.limit) : allRows;
  const nextCursor = mintNextCursor(
    pageRows,
    query.orderBy,
    target.primaryKey,
    fingerprint,
    hasMore,
  );

  // 6. Strip the augmented columns so the caller's projection is what comes
  //    back.
  const rows =
    effectiveSelect.length === 0
      ? pageRows
      : pageRows.map((row) => projectD1Fields(row, query.select));
  return Promise.resolve({ rows, nextCursor });
}

/** Project a full D1 row onto the caller's selected fields. */
function projectD1Fields(
  row: Record<string, unknown>,
  select: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of select) {
    if (field in row) projected[field] = row[field];
  }
  return projected;
}

/** SQLite's two measured unknown-column message forms; internal test data. @since 0.11.0 */
export const D1_UNKNOWN_COLUMN_PATTERNS: readonly RegExp[] = [
  /has no column named ([A-Za-z_][A-Za-z0-9_]*)/,
  /no such column: ([A-Za-z_][A-Za-z0-9_]*)/,
];

/** The payload keys of one write, which a SQLite refusal may name. Internal. */
export interface D1WriteContext {
  /** The repository entity the write addresses. */
  readonly entity: string;
  /** Its physical table, as SQLite names it in a STRICT refusal. */
  readonly table: string;
  /** The payload's own keys. */
  readonly keys: readonly string[];
}

/**
 * Map SQLite's refusal of a write to its named 400, or `undefined` when the
 * error is not one. An unknown-column message counts only when it names a key
 * of one of `writes`' payloads (a precondition column is not a payload field);
 * a STRICT-table refusal is attributed by its `table.column`, or to the only
 * write when the message carries none. One implementation for the direct
 * writes and the transaction commit, so the two paths cannot drift.
 *
 * @param error - The rejection D1 raised
 * @param writes - The writes the failed statement or batch carried
 * @returns The named refusal, or `undefined`
 */
export function d1WriteRefusal(
  error: unknown,
  writes: readonly D1WriteContext[],
): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  for (const pattern of D1_UNKNOWN_COLUMN_PATTERNS) {
    const field = pattern.exec(error.message)?.[1];
    if (field === undefined) continue;
    const write = writes.find((candidate) => candidate.keys.includes(field));
    if (write !== undefined) return new UnknownPayloadFieldError(write.entity, field);
  }
  const strict = /cannot store \w+ value in \w+ column(?: (\w+)\.(\w+))?/.exec(error.message);
  if (strict === null) return undefined;
  const [, table, column] = strict;
  const write =
    table === undefined || column === undefined
      ? writes.length === 1
        ? writes[0]
        : undefined
      : writes.find((candidate) => candidate.table === table && candidate.keys.includes(column));
  return write === undefined ? undefined : new InvalidFieldValueError(write.entity);
}

/** The refusal context of one write against `target`. */
function writeContext(target: D1Target, data: Readonly<Record<string, unknown>>): D1WriteContext {
  return { entity: target.entity, table: target.table, keys: Object.keys(data) };
}

/** Refuse payload fields and STRICT-table values without exposing values. */
async function refusedD1Write<T>(
  target: D1Target,
  data: Readonly<Record<string, unknown>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw d1WriteRefusal(error, [writeContext(target, data)]) ?? error;
  }
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

    async findById(id: EntityKey): Promise<Record<string, unknown> | null> {
      return await prepareStatement(db, buildSelectById(target, id)).first();
    },

    async create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const row = await refusedD1Write(target, data, () =>
        prepareStatement(db, buildInsert(target, data)).first(),
      );
      if (row === null) {
        throw new Error(
          `D1: insert into '${target.table}' returned no row. ` +
            'The table may be missing, or a trigger may have suppressed the insert.',
        );
      }
      return row;
    },

    async update(
      id: EntityKey,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      data = { ...data };
      assertPrimaryKeyUnchanged(target.table, target.primaryKey, id, data);
      const row = await refusedD1Write(target, data, () =>
        prepareStatement(db, buildUpdate(target, id, data)).first(),
      );
      if (row === null) {
        throw new Error(`Entity '${target.table}' with id '${JSON.stringify(id)}' not found`);
      }
      return row;
    },

    async delete(id: EntityKey): Promise<boolean> {
      const result = await prepareStatement(db, buildDelete(target, id)).all();
      return result.results.length > 0;
    },

    async updateWhere(id, where, data) {
      const checked = checkWritePrecondition(where, data);
      if (!checked.ok) throw new CloudflareUnsupportedError(checked.problem);
      where = checked.where;
      data = checked.data;
      assertPrimaryKeyUnchanged(target.table, target.primaryKey, id, data);
      return await refusedD1Write(target, data, () =>
        prepareStatement(db, buildUpdateWhere(target, id, where, data)).first(),
      );
    },
    async deleteWhere(id, where) {
      const checked = checkWritePrecondition(where);
      if (!checked.ok) throw new CloudflareUnsupportedError(checked.problem);
      where = checked.where;
      const result = await prepareStatement(db, buildDeleteWhere(target, id, where)).all();
      return result.results.length > 0;
    },

    async count(where: Record<string, unknown>, filter?: FilterExpression): Promise<number> {
      const row = await prepareStatement(db, buildCount(target, where, filter)).first();
      return readCount(row);
    },

    async findPage(query: NormalizedQuery): Promise<PageResult> {
      return await findD1Page(db, target, query);
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
  readonly #writes: D1WriteContext[] = [];
  #finalized = false;

  /**
   * Buffer one statement.
   *
   * @param statement - The built statement to apply at commit
   * @param write - The payload it carries, for mapping a commit-time refusal
   * @throws {Error} When the transaction has already been committed or rolled back
   */
  add(statement: D1Statement, write?: D1WriteContext): void {
    this.assertOpen();
    this.#statements.push(statement);
    if (write !== undefined) this.#writes.push(write);
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

  /**
   * The payload-carrying writes buffered so far, in insertion order.
   *
   * @returns Each write's refusal context
   */
  writes(): readonly D1WriteContext[] {
    return [...this.#writes];
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

    async findById(id: EntityKey): Promise<Record<string, unknown> | null> {
      buffer.assertOpen();
      return await committed.findById(id);
    },

    // eslint-disable-next-line require-await -- must reject, not throw synchronously
    async create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
      buffer.assertOpen();
      // A deferred INSERT cannot report a generated key back to a caller that
      // awaits create() before the flush. Rather than return a row whose id is
      // missing, or invent a client-side value that would be the wrong type for
      // an INTEGER key, refuse and name the constraint.
      //
      // One loop covers both key shapes: a scalar key is a one-column list, so
      // the previous scalar branch was the loop's single iteration written out
      // again — with the identical message, which is how the two came to sit
      // under a comment that had itself been pasted twice.
      for (const pk of target.primaryKey) {
        if (data[pk] === undefined) {
          throw new CloudflareUnsupportedError(
            `D1: create() inside a transaction requires an explicit ` +
              `'${pk}' for '${target.table}'. D1 has no interactive ` +
              'transaction, so writes are buffered and flushed as one batch() at commit, ' +
              'and a generated key is not known until then. Supply the key, or create ' +
              'outside the transaction where RETURNING * provides it.',
          );
        }
      }
      buffer.add(buildInsert(target, data), writeContext(target, data));
      return { ...data } as Record<string, unknown>;
    },

    async update(
      id: EntityKey,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      data = { ...data };
      assertPrimaryKeyUnchanged(target.table, target.primaryKey, id, data);
      buffer.assertOpen();
      const current = await committed.findById(id);
      if (current === null) {
        throw new Error(`Entity '${target.table}' with id '${JSON.stringify(id)}' not found`);
      }
      buffer.add(buildUpdate(target, id, data), writeContext(target, data));
      return { ...current, ...data };
    },

    async delete(id: EntityKey): Promise<boolean> {
      buffer.assertOpen();
      const current = await committed.findById(id);
      if (current === null) return false;
      buffer.add(buildDelete(target, id));
      return true;
    },

    async count(where: Record<string, unknown>, filter?: FilterExpression): Promise<number> {
      buffer.assertOpen();
      return await committed.count(where, filter);
    },

    async findPage(query: NormalizedQuery): Promise<PageResult> {
      // Reads observe committed state inside the transaction — the cursor walk
      // must honour it, so the shared pipeline runs against the committed
      // data source, not the deferred buffer.
      buffer.assertOpen();
      return await committed.findPage!(query);
    },
  };
}
