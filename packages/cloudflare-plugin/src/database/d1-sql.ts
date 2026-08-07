/**
 * Pure SQL construction for the D1 backend.
 *
 * Every function here is a total function from a normalized query to
 * `{ sql, params }` — no binding, no I/O, no state — which is what lets the
 * generated text be asserted verbatim in tests rather than inferred from how
 * a fake reacted to it.
 *
 * Two invariants hold across every builder:
 *
 * 1. **Values are always bound**, never interpolated. D1 uses positional
 *    `?N` placeholders.
 * 2. **Identifiers are never bound**, because SQL does not allow it — so each
 *    one is validated against a strict allowlist and then double-quoted. Table
 *    names, `where` keys, `orderBy` keys and `select` entries all reach this
 *    module from application code and, for a query built out of a request,
 *    potentially from user input.
 *
 * @module
 */

import type { NormalizedQuery } from '@setu-ts/common';
import { CloudflareUnsupportedError } from '../errors.ts';

/**
 * D1 binds at most this many parameters per query.
 *
 * A documented hard platform limit. Exceeding it fails inside D1 with an
 * error that points at the SQL rather than at the caller's query, so every
 * builder checks it and names the real cause instead.
 *
 * @see https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** A statement plus the values to bind into it, in positional order. */
export interface D1Statement {
  /** The SQL text, using `?1`-style positional placeholders. */
  readonly sql: string;
  /** The values to bind, in placeholder order. */
  readonly params: readonly unknown[];
}

/** What a builder needs to know about the entity it is addressing. */
export interface D1Target {
  /** The physical table name. */
  readonly table: string;
  /** The primary-key column. */
  readonly primaryKey: string;
}

/** SQLite identifiers this module will emit. Anything else is rejected. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and quote a SQL identifier.
 *
 * @param value - The raw identifier
 * @param position - Where it came from, for the error message
 * @returns The double-quoted identifier
 * @throws {CloudflareUnsupportedError} When the identifier is not a bare
 * `[A-Za-z_][A-Za-z0-9_]*` name
 */
export function quoteIdentifier(value: string, position: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new CloudflareUnsupportedError(
      `D1: ${position} '${value}' is not a valid SQL identifier. ` +
        'Only letters, digits and underscores are accepted, and the first ' +
        'character may not be a digit.',
    );
  }
  return `"${value}"`;
}

/**
 * Reject a statement that would exceed D1's bound-parameter limit.
 *
 * @param params - The parameters the statement would bind
 * @param kind - The statement kind, for the error message
 * @throws {CloudflareUnsupportedError} When there are more than
 * {@linkcode D1_MAX_BOUND_PARAMS}
 */
function assertParamBudget(params: readonly unknown[], kind: string): void {
  if (params.length > D1_MAX_BOUND_PARAMS) {
    throw new CloudflareUnsupportedError(
      `D1: this ${kind} would bind ${params.length} parameters, but D1 allows ` +
        `at most ${D1_MAX_BOUND_PARAMS} per query. Narrow the query or split the write.`,
    );
  }
}

/**
 * Build the `WHERE` fragment for an equality filter.
 *
 * `null` is compared with `IS NULL` rather than `= ?`, because SQL equality
 * against `NULL` is never true — a `where: { deletedAt: null }` filter would
 * silently match nothing otherwise.
 *
 * @param where - The equality conditions
 * @param params - The parameter accumulator, appended to in place
 * @returns The fragment including its leading space, or an empty string
 */
function buildWhere(where: Record<string, unknown>, params: unknown[]): string {
  const entries = Object.entries(where);
  if (entries.length === 0) return '';

  const clauses = entries.map(([column, value]) => {
    const quoted = quoteIdentifier(column, 'filter column');
    if (value === null) return `${quoted} IS NULL`;
    params.push(value);
    return `${quoted} = ?${params.length}`;
  });
  return ` WHERE ${clauses.join(' AND ')}`;
}

/**
 * Build the `ORDER BY` fragment.
 *
 * @param orderBy - Field-to-direction map
 * @returns The fragment including its leading space, or an empty string
 */
function buildOrderBy(orderBy: Record<string, string>): string {
  const entries = Object.entries(orderBy);
  if (entries.length === 0) return '';

  const clauses = entries.map(([column, direction]) =>
    `${quoteIdentifier(column, 'order column')} ${direction === 'desc' ? 'DESC' : 'ASC'}`
  );
  return ` ORDER BY ${clauses.join(', ')}`;
}

/**
 * Build a `SELECT` for a normalized query.
 *
 * `offset` without `limit` needs `LIMIT -1` — SQLite rejects a bare `OFFSET`,
 * and `-1` is its idiom for "unbounded".
 *
 * @param target - The table being queried
 * @param query - The normalized query
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier or a parameter overflow
 */
export function buildSelect(target: D1Target, query: NormalizedQuery): D1Statement {
  const params: unknown[] = [];
  const columns = query.select.length === 0
    ? '*'
    : query.select.map((c) => quoteIdentifier(c, 'selected column')).join(', ');

  let sql = `SELECT ${columns} FROM ${quoteIdentifier(target.table, 'table name')}`;
  sql += buildWhere(query.where, params);
  sql += buildOrderBy(query.orderBy);

  if (query.limit > 0) {
    params.push(query.limit);
    sql += ` LIMIT ?${params.length}`;
  } else if (query.offset > 0) {
    sql += ' LIMIT -1';
  }
  if (query.offset > 0) {
    params.push(query.offset);
    sql += ` OFFSET ?${params.length}`;
  }

  assertParamBudget(params, 'select');
  return { sql, params };
}

/**
 * Build a `SELECT` for a single row by primary key.
 *
 * @param target - The table being queried
 * @param id - The primary-key value
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier
 */
export function buildSelectById(target: D1Target, id: string | number): D1Statement {
  const sql = `SELECT * FROM ${quoteIdentifier(target.table, 'table name')} WHERE ` +
    `${quoteIdentifier(target.primaryKey, 'primary key')} = ?1 LIMIT 1`;
  return { sql, params: [id] };
}

/**
 * Build an `INSERT … RETURNING *`.
 *
 * `RETURNING *` is what makes the persisted row — generated columns included —
 * available to the caller in one round trip.
 *
 * @param target - The table being written
 * @param data - Column values to insert
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier, a parameter
 * overflow, or an empty row
 */
export function buildInsert(
  target: D1Target,
  data: Partial<Record<string, unknown>>,
): D1Statement {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw new CloudflareUnsupportedError(
      `D1: cannot insert an empty row into '${target.table}' — supply at least one column.`,
    );
  }

  const columns = entries.map(([c]) => quoteIdentifier(c, 'insert column')).join(', ');
  const placeholders = entries.map((_, i) => `?${i + 1}`).join(', ');
  const params = entries.map(([, v]) => v);

  assertParamBudget(params, 'insert');
  return {
    sql: `INSERT INTO ${quoteIdentifier(target.table, 'table name')} (${columns}) ` +
      `VALUES (${placeholders}) RETURNING *`,
    params,
  };
}

/**
 * Build an `UPDATE … RETURNING *`.
 *
 * The returned rows double as the existence check: an empty result means no
 * row carried that primary key.
 *
 * @param target - The table being written
 * @param id - The primary-key value
 * @param data - Columns to merge into the row
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier, a parameter
 * overflow, or an empty patch
 */
export function buildUpdate(
  target: D1Target,
  id: string | number,
  data: Partial<Record<string, unknown>>,
): D1Statement {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw new CloudflareUnsupportedError(
      `D1: cannot update '${target.table}' with an empty patch — supply at least one column.`,
    );
  }

  const params: unknown[] = [];
  const assignments = entries.map(([column, value]) => {
    params.push(value);
    return `${quoteIdentifier(column, 'update column')} = ?${params.length}`;
  }).join(', ');

  params.push(id);
  const sql = `UPDATE ${quoteIdentifier(target.table, 'table name')} SET ${assignments} ` +
    `WHERE ${quoteIdentifier(target.primaryKey, 'primary key')} = ?${params.length} RETURNING *`;

  assertParamBudget(params, 'update');
  return { sql, params };
}

/**
 * Build a `DELETE … RETURNING <pk>`.
 *
 * `RETURNING` the key is how the committed `Promise<boolean>` is honored
 * without a `meta.changes` field: an empty result means nothing matched.
 *
 * @param target - The table being written
 * @param id - The primary-key value
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier
 */
export function buildDelete(target: D1Target, id: string | number): D1Statement {
  const key = quoteIdentifier(target.primaryKey, 'primary key');
  return {
    sql: `DELETE FROM ${quoteIdentifier(target.table, 'table name')} ` +
      `WHERE ${key} = ?1 RETURNING ${key}`,
    params: [id],
  };
}

/** The column alias the count query projects into. */
export const D1_COUNT_ALIAS = 'count';

/**
 * Build a `SELECT COUNT(*)`.
 *
 * @param target - The table being counted
 * @param where - Equality filter; empty counts every row
 * @returns The statement and its parameters
 * @throws {CloudflareUnsupportedError} On an invalid identifier or a parameter overflow
 */
export function buildCount(target: D1Target, where: Record<string, unknown>): D1Statement {
  const params: unknown[] = [];
  let sql = `SELECT COUNT(*) AS "${D1_COUNT_ALIAS}" FROM ` +
    `${quoteIdentifier(target.table, 'table name')}`;
  sql += buildWhere(where, params);

  assertParamBudget(params, 'count');
  return { sql, params };
}
