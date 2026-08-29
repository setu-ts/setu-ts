/**
 * Pure translation of the portable query contract onto the native driver's
 * query language.
 *
 * No driver import lives here, so every branch is unit-testable with a hand
 * built filter and the coverage bar is met without a server. The driver
 * `filter` + `find` options are plain data — the adapter passes them to
 * `collection.find(filter, options)` — so this module produces exactly that
 * data.
 *
 * @module
 */
import type {
  FilterComparison,
  FilterExpression,
  NormalizedQuery,
  OrderDirection,
} from '@setu-ts/common';

/**
 * The native driver `find` options the query builder emits.
 *
 * @since 0.1.0
 */
export interface MongoFindOptions {
  /** Sort specification: field → direction. */
  readonly sort?: Record<string, OrderDirection>;
  /** Number of leading rows to skip. */
  readonly skip?: number;
  /** Maximum results, or omit for unlimited. */
  readonly limit?: number;
  /** Field projection: field → `1`. Empty means all fields. */
  readonly projection?: Record<string, 1>;
}

/**
 * Escapes the regex metacharacters the native driver treats as special in a
 * `contains` search, so a literal search for `3.5` matches `3.5` and not
 * `315`.
 *
 * Mongo's `.` and `*` ARE wildcards (the inverse of SQL's `%`/`_`, which
 * `PASSTHROUGH_PROVIDERS` records as already literal on Mongo), so escaping
 * them is mandatory rather than defensive — an unescaped pattern silently
 * matches more rows than the caller asked for.
 *
 * @param value - The literal search value
 * @returns The value with metacharacters escaped
 * @since 0.1.0
 */
export function escapeRegex(value: string): string {
  // `.*+?^${}()|[]\` — the metacharacters the native driver treats specially.
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translates a single {@linkcode FilterComparison} onto native Mongo match
 * operators.
 *
 * `eq`/`gt`/`gte`/`lt`/`lte` map to `$eq`/`$gt`/`$gte`/`$lt`/`$lte`; `in`
 * maps to `$in` (an empty list becomes a match-nothing predicate, and a list
 * containing `null` keeps the `null`, which Mongo matches for both a null
 * value and a missing field); `contains` maps to a regex-escaped `$regex`
 * with an empty `$options`, which is **case-sensitive**: MongoDB does not apply
 * a collection's collation to `$regex`, so a case-insensitive collation does
 * not make this match case-insensitive (measured against a `strength: 2`
 * collection, where `$eq` matched and `$regex` did not).
 *
 * @param comparison - The comparison to translate
 * @returns The operator document
 * @since 0.1.0
 */
export function translateComparison(
  comparison: FilterComparison,
): Record<string, unknown> | undefined {
  const { operator } = comparison;
  switch (operator) {
    case 'eq':
      return { $eq: comparison.value };
    case 'contains':
      return { $regex: escapeRegex(comparison.value), $options: '' };
    case 'gt':
      return { $gt: comparison.value };
    case 'gte':
      return { $gte: comparison.value };
    case 'lt':
      return { $lt: comparison.value };
    case 'lte':
      return { $lte: comparison.value };
    case 'in': {
      const values = comparison.value;
      if (values.length === 0) {
        // An empty `$in` matches nothing — a deliberate, documented edge
        // (M68's `IN` never matched `NULL`, so this is a new Mongo-specific
        // behaviour, not a carry-over).
        return { $in: [] };
      }
      return { $in: [...values] };
    }
  }
}

/**
 * Translates a portable {@linkcode FilterExpression} onto a native Mongo
 * match document.
 *
 * `and`/`or` map to `$and`/`$or`; a `comparison` maps through
 * {@linkcode translateComparison}. An `eq` comparison is folded into the
 * `where`-equivalent document (the caller supplies the equality half); a
 * non-`eq` comparison is nested under its field path so the operator document
 * sits beside the field name.
 *
 * @param expression - The expression to translate
 * @returns The match document
 * @since 0.1.0
 */
export function translateFilter(expression: FilterExpression): Record<string, unknown> {
  if (expression.type !== 'comparison') {
    if (expression.filters.length === 0) {
      // `FilterExpression` permits an empty group and `normalizeQuery` forwards
      // it unchanged, but MongoDB refuses `$and: []`/`$or: []` outright
      // ("$and argument must be a non-empty array"). The group therefore
      // compiles to its boolean identity, which is what the other adapters
      // already produce — Memory via `every`/`some`, Drizzle via its
      // tautology/contradiction pair: an empty `and` matches every document,
      // an empty `or` matches none. `$nor: [{}]` is the negation of match-all,
      // and both forms compose inside an enclosing `$and`.
      return expression.type === 'and' ? {} : { $nor: [{}] };
    }
    const key = expression.type === 'and' ? '$and' : '$or';
    return {
      [key]: expression.filters.map((child) => translateFilter(child)),
    };
  }
  // Every comparison is nested under its field path so a filter-only `eq`
  // remains a predicate rather than silently matching every document.
  const operators = translateComparison(expression);
  return { [expression.field]: operators };
}

/**
 * Translates a {@linkcode NormalizedQuery} onto the driver's native query: a
 * `filter` match document plus `find` options.
 *
 * Every member of `NormalizedQuery` maps natively — `where` (equality record)
 * and `filter` (portable expression) form the match document, `orderBy` maps
 * to `sort`, `offset`/`limit` map to `skip`/`limit`, and `select` maps to a
 * projection. Nothing is emulated in JavaScript.
 *
 * @param query - The fully-resolved normalized query
 * @returns The native `filter` and `find` options
 * @since 0.1.0
 */
export function translateQuery(query: NormalizedQuery): {
  filter: Record<string, unknown>;
  options: MongoFindOptions;
} {
  const where = { ...query.where };
  const expression = query.filter === undefined ? undefined : translateFilter(query.filter);
  const filter = expression === undefined
    ? where
    : Object.keys(where).length === 0
    ? expression
    : { $and: [where, expression] };

  // `MongoFindOptions` properties are `readonly` optionals, so each is folded
  // into the object literal only when the corresponding query clause is present.
  const projection: Record<string, 1> | undefined = query.select.length > 0
    ? query.select.reduce<Record<string, 1>>((acc, field) => {
      acc[field] = 1;
      return acc;
    }, {})
    : undefined;

  const options: MongoFindOptions = {
    ...(Object.keys(query.orderBy).length > 0 ? { sort: { ...query.orderBy } } : {}),
    ...(query.offset > 0 ? { skip: query.offset } : {}),
    ...(query.limit >= 0 ? { limit: query.limit } : {}),
    ...(projection ? { projection } : {}),
  };

  return { filter, options };
}

/**
 * Translates a `{ where, filter? }` pair — the shape `count` receives — onto
 * a native Mongo match document.
 *
 * @param where - Equality conditions
 * @param filter - Optional portable expression
 * @returns The match document
 * @since 0.1.0
 */
export function translateCountFilter(
  where: Record<string, unknown>,
  filter?: FilterExpression,
): Record<string, unknown> {
  const equality = { ...where };
  if (filter === undefined) return equality;
  const expression = translateFilter(filter);
  return Object.keys(equality).length === 0 ? expression : { $and: [equality, expression] };
}
