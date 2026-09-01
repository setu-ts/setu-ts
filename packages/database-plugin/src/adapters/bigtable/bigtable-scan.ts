/**
 * The scan planner: a {@linkcode NormalizedQuery} becomes a Bigtable read.
 *
 * Bigtable has **no secondary index of any kind**, so exactly three things can
 * be answered by the server, and this module emits those and nothing else:
 *
 * 1. **The row set** — an `eq` on every row-key field is an exact key, an `eq`
 *    pinning a leading prefix is a prefix range, and a pinned prefix plus an
 *    `in` on the final field is an explicit key list.
 * 2. **Byte-exact value equality** — each conjunctive `eq` on a non-key field
 *    becomes a nested `condition` filter whose test is an exact value RANGE.
 *    Never the SDK's string form, which is a regex: measured, `{ value: 'a.*b' }`
 *    matched both `a.*b` and `axxb`.
 * 3. **Column projection** — the columns a projected query actually needs,
 *    interleaved with a one-cell arm so a row carrying none of them is still
 *    returned rather than silently dropped.
 *
 * Everything else is evaluated client-side by `matchesFilter`, the same
 * evaluator the memory adapter uses, so the six backends cannot drift about
 * what a `FilterExpression` means.
 *
 * **The superset invariant.** A push-down may only ever match a SUPERSET of
 * what the client-side evaluator keeps. Every fallback in this file widens
 * rather than narrows, which is what makes an encoding mismatch wasted work
 * instead of a wrong answer.
 *
 * @module
 */
import type {
  FilterComparison,
  FilterExpression,
  NormalizedQuery,
  OrderDirection,
} from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../errors.ts';
import type {
  BigtableFilter,
  BigtableReadOptions,
  BigtableRowRange,
} from './bigtable-client-types.ts';
import type { BigtableTarget } from './bigtable-mapping.ts';
import { columnAddress } from './bigtable-mapping.ts';
import { prefixSuccessor } from './bigtable-row-key.ts';
import { encodeCellValue } from './bigtable-value.ts';

/** The adapter name every refusal carries. */
const ADAPTER = 'bigtable';

/** What a planned read asks for, plus what the planner could NOT push down. */
export interface BigtableScanPlan {
  /** The server-side read request. */
  readonly read: BigtableReadOptions;
  /**
   * `true` when the constraints are self-contradictory or name an empty key
   * set, so no row can match and no read need be issued at all.
   */
  readonly empty: boolean;
  /**
   * `true` when `limit` was pushed to the server, so the caller must not also
   * apply it — and, more importantly, must not treat a short answer as
   * evidence of a filtered-out row.
   */
  readonly serverLimited: boolean;
}

/** Options narrowing one planned read. */
export interface BigtableScanPlanOptions {
  /** Continue strictly after this row key (the cursor's start-key mechanism). */
  readonly after?: string;
  /**
   * Replace the projection with a value-stripping pass. Valid only when the
   * caller needs no cell value at all — the `count` path with no residual
   * client-side filter.
   */
  readonly stripValues?: boolean;
}

/**
 * Refuses an `orderBy` Bigtable cannot serve.
 *
 * Rows always arrive in row-key order, so an empty `orderBy` is honoured and so
 * is one naming **exactly** the mapped key fields, in order, all ascending.
 * Everything else is refused:
 *
 * - a non-key field has no index to sort by;
 * - `'desc'` would need a reverse scan, and the available emulator **silently
 *   ignores** `reversed: true` (measured — it answered ascending with no
 *   error), so a descending path could not be verified and is refused rather
 *   than shipped;
 * - a strict PREFIX of the key fields is refused because prefix order only
 *   follows full-key order while the separator sorts below every byte a field
 *   value can contain, which no cheap check can guarantee.
 *
 * @param target - The resolved entity target
 * @param orderBy - The caller's sort specification
 * @throws {UnsupportedQueryFeatureError} When the sort is not row-key order
 */
function assertSupportedOrderBy(
  target: BigtableTarget,
  orderBy: Readonly<Record<string, OrderDirection>>,
): void {
  const entries = Object.entries(orderBy);
  if (entries.length === 0) return;
  const natural = entries.length === target.keyFields.length &&
    entries.every(([field, direction], index) =>
      field === target.keyFields[index] && direction === 'asc'
    );
  if (natural) return;
  throw new UnsupportedQueryFeatureError(
    'order-by',
    ADAPTER,
    `Bigtable entity '${target.entity}' can only be ordered by its row key. Bigtable has no ` +
      `secondary index, so the only sort available is the full key ` +
      `[${target.keyFields.join(', ')}] ascending, or no sort at all. Descending is refused ` +
      `because a reverse scan cannot be verified against the emulator this adapter is tested on.`,
  );
}

/**
 * Refuses a non-zero `offset`.
 *
 * Bigtable has no row offset. Emulating one by discarding scanned rows would
 * read and bill them while reporting success, so the refusal names cursor
 * pagination instead.
 *
 * @param target - The resolved entity target
 * @param offset - The caller's offset
 * @throws {UnsupportedQueryFeatureError} When the offset is non-zero
 */
function assertNoOffset(target: BigtableTarget, offset: number): void {
  if (offset === 0) return;
  throw new UnsupportedQueryFeatureError(
    'offset',
    ADAPTER,
    `Bigtable entity '${target.entity}' cannot skip ${offset} rows: Bigtable has no row offset, ` +
      `and discarding scanned rows would read and bill them. Use cursor pagination (findPage).`,
  );
}

/**
 * Flattens the conjunctive top level of a query's constraints.
 *
 * `where` entries are equality comparisons by definition; a `filter` that is a
 * bare comparison, or an `and` of them (recursively), contributes its legs. An
 * `or` contributes nothing — no leg of a disjunction constrains every row.
 *
 * @param where - The equality map
 * @param filter - The portable expression, when present
 * @returns Every comparison that must hold for a row to match
 */
function conjunctiveComparisons(
  where: Readonly<Record<string, unknown>>,
  filter: FilterExpression | undefined,
): FilterComparison[] {
  const comparisons: FilterComparison[] = Object.entries(where).map(([field, value]) => ({
    type: 'comparison',
    field,
    operator: 'eq',
    value,
  }));
  const walk = (expression: FilterExpression): void => {
    if (expression.type === 'comparison') {
      comparisons.push(expression);
      return;
    }
    if (expression.type === 'and') expression.filters.forEach(walk);
  };
  if (filter !== undefined) walk(filter);
  return comparisons;
}

/**
 * Every field a query's constraints read, by root name — the set a projected
 * read must keep so the client-side evaluator can still decide.
 *
 * Exported so `count` can project to exactly the columns its predicate needs
 * instead of reading every column of a wide row; not re-exported from the
 * package barrel, because the set is an internal read-planning detail.
 *
 * @param where - The equality map
 * @param filter - The portable expression, when present
 * @returns Every root field name the constraints mention
 * @since 0.2.0
 */
export function constraintFieldRoots(
  where: Readonly<Record<string, unknown>>,
  filter: FilterExpression | undefined,
): string[] {
  const fields = new Set<string>(Object.keys(where));
  if (filter !== undefined) collectFilterFields(filter, fields);
  return [...fields];
}

/**
 * Collects the root field name of every comparison anywhere in a filter tree,
 * disjunctions included.
 *
 * @param filter - The expression to walk
 * @param into - The set to add to
 */
function collectFilterFields(filter: FilterExpression, into: Set<string>): void {
  if (filter.type === 'comparison') {
    into.add(typeof filter.field === 'string' ? filter.field : filter.field[0]);
    return;
  }
  for (const child of filter.filters) collectFilterFields(child, into);
}

/**
 * Renders one key-field value for a push-down, or reports that it cannot.
 *
 * Returns `null` rather than throwing: a value the planner cannot render is a
 * value the SERVER cannot be narrowed by, and widening the read is always safe
 * — the client-side evaluator still decides. Throwing here would refuse a query
 * the adapter can answer perfectly well, only less cheaply.
 *
 * @param target - The resolved entity target
 * @param value - The candidate value
 * @returns The rendered segment, or `null` when it cannot be used
 */
function tryRenderSegment(target: BigtableTarget, value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const rendered = String(value);
    return target.keyFields.length > 1 && rendered.includes(target.separator) ? null : rendered;
  }
  if (typeof value !== 'string') return null;
  if (target.keyFields.length > 1 && value.includes(target.separator)) return null;
  return value;
}

/** The row-set narrowing derived from the key constraints. */
interface RowSet {
  /** An explicit key list, when the whole key is pinned. */
  readonly keys?: readonly string[];
  /** A row-key range, when only a prefix is pinned. */
  readonly range?: BigtableRowRange;
  /** `true` when the constraints admit no row at all. */
  readonly empty: boolean;
}

/**
 * Derives the row set from the conjunctive key constraints.
 *
 * @param target - The resolved entity target
 * @param comparisons - The conjunctive comparisons
 * @returns The narrowing, or an unbounded range over the entity's prefix
 */
function deriveRowSet(target: BigtableTarget, comparisons: readonly FilterComparison[]): RowSet {
  const equals = new Map<string, string>();
  const contradictory = new Set<string>();
  const inLists = new Map<string, readonly unknown[]>();
  for (const comparison of comparisons) {
    if (typeof comparison.field !== 'string') continue;
    if (!target.keyFields.includes(comparison.field)) continue;
    if (comparison.operator === 'eq') {
      const rendered = tryRenderSegment(target, comparison.value);
      if (rendered === null) continue;
      const existing = equals.get(comparison.field);
      // Two different `eq` values on one field can never both hold, so the
      // query matches nothing. Recorded rather than pushed down, because
      // pushing one of them down would be a narrowing the client-side
      // evaluator agrees with only by accident.
      if (existing !== undefined && existing !== rendered) contradictory.add(comparison.field);
      equals.set(comparison.field, rendered);
    } else if (comparison.operator === 'in') {
      inLists.set(comparison.field, comparison.value);
    }
  }
  if (contradictory.size > 0) return { empty: true };

  let pinned = 0;
  const segments: string[] = [];
  while (pinned < target.keyFields.length) {
    const rendered = equals.get(target.keyFields[pinned]);
    if (rendered === undefined) break;
    segments.push(rendered);
    pinned += 1;
  }

  if (pinned === target.keyFields.length) {
    return { keys: [target.prefix + segments.join(target.separator)], empty: false };
  }

  // A pinned prefix plus an `in` on the FINAL remaining field names an exact,
  // finite key set. An empty `in` names none — which is genuinely "no rows",
  // and the one place this planner narrows to nothing on purpose.
  if (pinned === target.keyFields.length - 1) {
    const candidates = inLists.get(target.keyFields[pinned]);
    if (candidates !== undefined) {
      if (candidates.length === 0) return { empty: true };
      const rendered = candidates.map((value) => tryRenderSegment(target, value));
      if (rendered.every((segment): segment is string => segment !== null)) {
        const keys = [
          ...new Set(
            rendered.map((segment) =>
              target.prefix + [...segments, segment].join(target.separator)
            ),
          ),
        ];
        return { keys, empty: false };
      }
    }
  }

  const prefix = pinned === 0
    ? target.prefix
    : target.prefix + segments.join(target.separator) + target.separator;
  if (prefix === '') return { empty: false };
  const end = prefixSuccessor(prefix);
  return {
    range: end === undefined
      ? { start: { value: prefix, inclusive: true } }
      : { start: { value: prefix, inclusive: true }, end: { value: end, inclusive: false } },
    empty: false,
  };
}

/**
 * Applies a cursor's start key to a derived row set.
 *
 * @param rowSet - The derived narrowing
 * @param after - The row key to continue strictly after
 * @returns The narrowed row set
 */
function applyCursor(rowSet: RowSet, after: string): RowSet {
  if (rowSet.empty) return rowSet;
  if (rowSet.keys !== undefined) {
    const keys = rowSet.keys.filter((key) => key > after);
    return keys.length === 0 ? { empty: true } : { keys, empty: false };
  }
  const start = { value: after, inclusive: false };
  const range = rowSet.range;
  if (range === undefined) return { range: { start }, empty: false };
  // The cursor only ever moves the lower bound FORWARD: a cursor behind the
  // derived range would otherwise widen the scan back to rows the key
  // constraints already excluded.
  const lower = range.start !== undefined && range.start.value > after ? range.start : start;
  return {
    range: range.end === undefined ? { start: lower } : { start: lower, end: range.end },
    empty: false,
  };
}

/**
 * Builds the exact-value test chain for one pushed-down `eq`.
 *
 * @param target - The resolved entity target
 * @param field - The non-key field being tested
 * @param value - The expected value
 * @returns The test chain
 */
function valueTest(target: BigtableTarget, field: string, value: unknown): BigtableFilter[] {
  const address = columnAddress(target, field);
  const encoded = encodeCellValue(value, target.valueEncoding);
  return [
    { family: address.family },
    { column: [address.qualifier] },
    // The degenerate byte RANGE, never the string form — measured, the string
    // form is a regex and matched a value it should not have.
    { value: { start: encoded, end: encoded } },
  ];
}

/**
 * Resolves the qualifiers a projected read must keep.
 *
 * The key fields are always included: their cells are what preserve a key
 * field's TYPE, and the row-key parse-back that would otherwise fill them
 * yields strings.
 *
 * @param target - The resolved entity target
 * @param query - The normalized query
 * @returns The qualifiers to keep, or `null` when nothing may be projected away
 */
function projectionQualifiers(
  target: BigtableTarget,
  query: NormalizedQuery,
): string[] | null {
  if (query.select.length === 0) return null;
  const fields = new Set<string>(target.keyFields);
  for (const field of query.select) fields.add(field);
  for (const field of Object.keys(query.orderBy)) fields.add(field);
  for (const field of Object.keys(query.where)) fields.add(field);
  if (query.filter !== undefined) collectFilterFields(query.filter, fields);
  return [...new Set([...fields].map((field) => columnAddress(target, field).qualifier))];
}

/**
 * Folds the pushed-down value conditions around the innermost pass-through.
 *
 * Each condition is a CheckAndMutateRow-style `condition` filter rather than a
 * bare value chain, because a bare chain STRIPS every non-matching cell from
 * the answer — measured — so the row would come back carrying only the cell
 * that matched.
 *
 * @param tests - One test chain per pushed-down `eq`
 * @param innermost - The pass-through applied to a row that satisfies them all
 * @returns The composed filter, or `undefined` when nothing is filtered
 */
function foldConditions(
  tests: readonly (readonly BigtableFilter[])[],
  innermost: readonly BigtableFilter[],
): BigtableFilter | undefined {
  let pass: readonly BigtableFilter[] = innermost;
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    pass = [{
      condition: { test: tests[index], pass: pass.length === 0 ? [{ all: true }] : pass },
    }];
  }
  if (pass.length === 0) return undefined;
  return pass.length === 1 ? pass[0] : { chain: pass };
}

/**
 * Plans one Bigtable read for a normalized query.
 *
 * @param target - The resolved entity target
 * @param query - The fully-resolved query
 * @param options - Cursor and projection narrowing
 * @returns The plan
 * @throws {UnsupportedQueryFeatureError} When `orderBy` or `offset` cannot be
 *   served, or a named field is not a usable column identifier
 * @since 0.2.0
 */
export function planBigtableScan(
  target: BigtableTarget,
  query: NormalizedQuery,
  options: BigtableScanPlanOptions = {},
): BigtableScanPlan {
  assertNoOffset(target, query.offset);
  assertSupportedOrderBy(target, query.orderBy);

  const comparisons = conjunctiveComparisons(query.where, query.filter);
  let rowSet = deriveRowSet(target, comparisons);
  if (options.after !== undefined) rowSet = applyCursor(rowSet, options.after);
  if (rowSet.empty) return { read: {}, empty: true, serverLimited: false };

  const tests: BigtableFilter[][] = [];
  for (const comparison of comparisons) {
    if (comparison.operator !== 'eq') continue;
    if (typeof comparison.field !== 'string') continue;
    if (target.keyFields.includes(comparison.field)) continue;
    // `undefined` has no cell, so an exact-value test could only exclude the
    // very rows a matching absence would keep — the one narrowing that would
    // break the superset invariant.
    if (comparison.value === undefined) continue;
    tests.push(valueTest(target, comparison.field, comparison.value));
  }

  const innermost: BigtableFilter[] = options.stripValues === true
    ? [{ value: { strip: true } }]
    : (() => {
      const qualifiers = projectionQualifiers(target, query);
      if (qualifiers === null) return [];
      // Interleaved with a one-cell arm, NOT emitted bare. A filter that
      // removes every cell of a row removes the ROW — the service does not
      // answer with an empty row (measured) — so a projection naming columns a
      // given row happens not to carry would silently drop it. That is
      // unreachable for a row this adapter wrote, whose key field is always a
      // cell, and entirely reachable for a table written elsewhere. The extra
      // arm costs at most one cell per row, which the caller's own `select`
      // then discards.
      return [{
        interleave: [[{ column: qualifiers }], [{ row: { cellLimit: 1 } }]],
      }];
    })();

  // The limit is pushed down only when EVERY scanned row is a match, so a
  // short answer cannot be mistaken for a filtered-out row.
  const serverLimited = query.limit > 0 && Object.keys(query.where).length === 0 &&
    query.filter === undefined;

  const filter = foldConditions(tests, innermost);
  const read: BigtableReadOptions = {
    ...(rowSet.keys === undefined ? {} : { keys: rowSet.keys }),
    ...(rowSet.range === undefined ? {} : { ranges: [rowSet.range] }),
    ...(filter === undefined ? {} : { filter }),
    ...(serverLimited ? { limit: query.limit } : {}),
  };
  return { read, empty: false, serverLimited };
}
