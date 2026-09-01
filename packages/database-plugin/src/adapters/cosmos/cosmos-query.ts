/**
 * Pure `NormalizedQuery` → Cosmos SQL translation.
 *
 * Every value is BOUND as an `@pN` parameter and never interpolated, and every
 * field is addressed with bracket syntax (`c["field"]`, `c["a"]["b"]`), which
 * is what serves a reserved word or a name carrying a space — dotted
 * addressing does not. Identifiers cannot be bound in any SQL dialect, so the
 * bracket form plus a quote-escaping guard is the identifier half of the same
 * rule M52c established for D1.
 *
 * The translation is pure: no client, no I/O, so every emitted statement is
 * unit-testable as text.
 *
 * @module
 */
import type { FilterExpression, NormalizedQuery, OrderDirection } from '@setu-ts/common';
import type { CosmosQueryParameter, CosmosQuerySpec } from './cosmos-client-types.ts';
import type { CosmosTarget } from './cosmos-mapping.ts';
import { documentField } from './cosmos-mapping.ts';

/** The alias every emitted statement binds the container to. */
const ROOT = 'c';

/**
 * The largest `LIMIT` Cosmos accepts, used when a caller asks for an unlimited
 * page from a non-zero offset.
 *
 * Cosmos rejects `OFFSET` without `LIMIT` (measured: a 400), and it rejects
 * `LIMIT -1` (also a 400), so the contract's `-1` sentinel cannot be passed
 * through. With no offset the clause is simply omitted; with one, this is the
 * only spelling of "no upper bound" the dialect has.
 */
const UNBOUNDED_LIMIT = 2147483647;

/**
 * An accumulator that mints one parameter name per bound value.
 *
 * A fresh instance per statement keeps the names dense and deterministic,
 * which is what makes the emitted text assertable in a unit test.
 */
class ParameterBag {
  readonly #parameters: CosmosQueryParameter[] = [];

  /**
   * Binds one value and returns the placeholder that addresses it.
   *
   * @param value - The value to bind
   * @returns The `@pN` placeholder
   */
  bind(value: unknown): string {
    const name = `@p${this.#parameters.length}`;
    this.#parameters.push({ name, value: normalizeValue(value) });
    return name;
  }

  /**
   * The bound parameters, in binding order.
   *
   * @returns The parameter list
   */
  collect(): readonly CosmosQueryParameter[] {
    return this.#parameters;
  }
}

/**
 * Converts a value into the JSON form Cosmos stores and compares against.
 *
 * A `Date` becomes its ISO string, because that is what the SDK writes for a
 * `Date` document value (measured) — comparing a `Date` instance against a
 * stored ISO string would otherwise match nothing.
 *
 * @param value - The value to bind
 * @returns The JSON-comparable form
 * @since 0.2.0
 */
export function normalizeValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Renders one field path as a bracket-addressed expression.
 *
 * @param field - The repository field name, or a nested segment list
 * @param target - The resolved entity target (for the primary-key rename)
 * @returns The addressing expression, for example `c["address"]["city"]`
 * @throws {Error} When a segment carries a double quote, which no legitimate
 *   field name does and which would otherwise let a field name escape its own
 *   string literal
 * @since 0.2.0
 */
export function fieldExpression(
  field: string | readonly string[],
  target: CosmosTarget,
): string {
  const segments = typeof field === 'string' ? [documentField(field, target)] : field.map(
    (segment, index) => (index === 0 ? documentField(segment, target) : segment),
  );
  return segments.reduce<string>((expression, segment) => {
    // Cosmos SQL treats a backslash as an ESCAPE character inside a quoted
    // accessor, so a segment ending in one escapes the closing quote and the
    // service rejects the statement (measured). A double quote closes the
    // accessor outright. Both are refused rather than escaped: `c["we\\ird"]`
    // does work (also measured), but a field name carrying either character is
    // pathological, and a named refusal is the D1 identifier precedent.
    if (segment.includes('"') || segment.includes('\\')) {
      throw new Error(
        `CosmosAdapter cannot address the field '${segment}': a field name may not contain a ` +
          'double quote or a backslash, because Cosmos SQL reads both inside a quoted accessor',
      );
    }
    return `${expression}["${segment}"]`;
  }, ROOT);
}

/**
 * Renders a portable filter expression as Cosmos SQL, binding every value.
 *
 * The operator mapping is measured rather than assumed: `contains` compiles to
 * `CONTAINS`, a LITERAL substring match in which `%` and `_` carry no special
 * meaning, so the escaping the SQL adapters must apply would corrupt the value
 * here (the inverse of the same reasoning the Mongo adapter records for
 * `$regex`); and `in` compiles to `ARRAY_CONTAINS` with the list bound as ONE
 * array parameter, which also gives the empty-list match-nothing case natively
 * where D1 needed an explicit branch.
 *
 * @param filter - The portable expression
 * @param target - The resolved entity target
 * @param bag - The parameter accumulator
 * @returns The SQL predicate text
 * @since 0.2.0
 */
export function filterExpression(
  filter: FilterExpression,
  target: CosmosTarget,
  bag: ParameterBag,
): string {
  if (filter.type !== 'comparison') {
    // An empty group compiles to its boolean identity — an empty `and` matches
    // every row and an empty `or` matches none, the answers Memory and Drizzle
    // give — rather than to an empty parenthesis the dialect would reject.
    if (filter.filters.length === 0) return filter.type === 'and' ? 'true' : 'false';
    const parts = filter.filters.map((child) => filterExpression(child, target, bag));
    return `(${parts.join(filter.type === 'and' ? ' AND ' : ' OR ')})`;
  }

  const field = fieldExpression(filter.field, target);
  switch (filter.operator) {
    case 'eq':
      return equality(field, filter.value, bag);
    case 'contains':
      return `CONTAINS(${field}, ${bag.bind(filter.value)})`;
    case 'in':
      return `ARRAY_CONTAINS(${bag.bind(filter.value.map(normalizeValue))}, ${field})`;
    default:
      return `${field} ${COMPARISON_OPERATORS[filter.operator]} ${bag.bind(filter.value)}`;
  }
}

/**
 * Renders one equality predicate, using `IS_NULL` when the comparand is `null`.
 *
 * Microsoft's documentation states that `WHERE c.field = null` does not match a
 * property whose value is JSON `null`, because the comparison does not evaluate
 * to `true`. Measured against the emulator the BOUND form does match — a bound
 * `@pN` carrying `null` and `IS_NULL` return the identical row set — so the two
 * disagree, and this repository holds no live Cosmos account to settle it. The
 * form both agree on is therefore emitted: `IS_NULL` is correct on the emulator
 * and is what the service documents, so it cannot be wrong on either.
 *
 * A property that is ABSENT is matched by neither, which is what the Memory
 * adapter's `===` also answers.
 *
 * @param field - The already-rendered field expression
 * @param value - The comparand
 * @param bag - The parameter accumulator
 * @returns The predicate text
 * @since 0.2.0
 */
export function equality(field: string, value: unknown, bag: ParameterBag): string {
  return value === null ? `IS_NULL(${field})` : `${field} = ${bag.bind(value)}`;
}

/** The SQL spelling of each ordered-comparison operator. */
const COMPARISON_OPERATORS: Readonly<Record<'gt' | 'gte' | 'lt' | 'lte', string>> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * Renders the `WHERE` clause for an equality map conjoined with an optional
 * portable expression.
 *
 * @param where - The equality conditions
 * @param filter - The portable expression, or none
 * @param target - The resolved entity target
 * @param bag - The parameter accumulator
 * @returns The clause including its leading `WHERE`, or an empty string
 * @since 0.2.0
 */
export function whereClause(
  where: Record<string, unknown>,
  filter: FilterExpression | undefined,
  target: CosmosTarget,
  bag: ParameterBag,
): string {
  const predicates: string[] = [];
  for (const [field, value] of Object.entries(where)) {
    predicates.push(equality(fieldExpression(field, target), value, bag));
  }
  if (filter !== undefined) predicates.push(filterExpression(filter, target, bag));
  return predicates.length === 0 ? '' : ` WHERE ${predicates.join(' AND ')}`;
}

/**
 * Renders the `ORDER BY` clause.
 *
 * @param orderBy - The field-to-direction map
 * @param target - The resolved entity target
 * @returns The clause including its leading `ORDER BY`, or an empty string
 * @since 0.2.0
 */
export function orderByClause(
  orderBy: Record<string, OrderDirection>,
  target: CosmosTarget,
): string {
  const parts = Object.entries(orderBy).map(
    ([field, direction]) =>
      `${fieldExpression(field, target)} ${direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return parts.length === 0 ? '' : ` ORDER BY ${parts.join(', ')}`;
}

/**
 * Renders the `OFFSET`/`LIMIT` clause.
 *
 * Three measured constraints shape this: `LIMIT -1` is refused, `OFFSET`
 * without `LIMIT` is refused, and a very large `LIMIT` is accepted. So the
 * contract's `-1` sentinel omits the clause entirely when there is no offset,
 * and pairs the offset with {@linkcode UNBOUNDED_LIMIT} when there is one.
 *
 * @param limit - The row cap, or `-1` for unlimited
 * @param offset - The number of leading rows to skip
 * @param bag - The parameter accumulator
 * @returns The clause, or an empty string when neither bound applies
 * @since 0.2.0
 */
export function paginationClause(limit: number, offset: number, bag: ParameterBag): string {
  const unlimited = limit < 0;
  if (unlimited && offset <= 0) return '';
  const effectiveLimit = unlimited ? UNBOUNDED_LIMIT : limit;
  return ` OFFSET ${bag.bind(Math.max(offset, 0))} LIMIT ${bag.bind(effectiveLimit)}`;
}

/**
 * Renders the projection list.
 *
 * An empty projection selects the whole document as `*`, NOT as the container
 * alias: `SELECT c FROM c` is legal Cosmos SQL and returns each document
 * WRAPPED under a `c` key, so every row would arrive as `{ c: { … } }` and
 * carry none of the caller's fields (measured against the emulator — it is
 * what made a keyset page fail to read its own sort field). A non-empty
 * projection carries exactly the requested fields and nothing else —
 * `findPage` widens its own projection to reach the key and ordered columns it
 * needs, then strips them, so adding them here would return a field the caller
 * never asked for.
 *
 * @param select - The requested repository fields
 * @param target - The resolved entity target
 * @returns The projection text following `SELECT`
 * @since 0.2.0
 */
export function selectClause(select: readonly string[], target: CosmosTarget): string {
  if (select.length === 0) return '*';
  return [...new Set(select)].map((field) => fieldExpression(field, target)).join(', ');
}

/**
 * Translates a fully-resolved query into Cosmos SQL.
 *
 * @param query - The normalized query
 * @param target - The resolved entity target
 * @returns The parameterized statement
 * @since 0.2.0
 */
export function buildQuery(query: NormalizedQuery, target: CosmosTarget): CosmosQuerySpec {
  const bag = new ParameterBag();
  const projection = selectClause(query.select, target);
  const where = whereClause(query.where, query.filter, target, bag);
  const order = orderByClause(query.orderBy, target);
  const pagination = paginationClause(query.limit, query.offset, bag);
  return {
    query: `SELECT ${projection} FROM ${ROOT}${where}${order}${pagination}`,
    parameters: bag.collect(),
  };
}

/**
 * Translates a count into Cosmos SQL.
 *
 * @param where - The equality conditions
 * @param filter - The portable expression, or none
 * @param target - The resolved entity target
 * @returns The parameterized statement, whose single row is the count
 * @since 0.2.0
 */
export function buildCountQuery(
  where: Record<string, unknown>,
  filter: FilterExpression | undefined,
  target: CosmosTarget,
): CosmosQuerySpec {
  const bag = new ParameterBag();
  const clause = whereClause(where, filter, target, bag);
  return {
    query: `SELECT VALUE COUNT(1) FROM ${ROOT}${clause}`,
    parameters: bag.collect(),
  };
}

/**
 * Translates a lookup of one document by its `id` across every partition.
 *
 * Two rows are fetched rather than one so the caller can tell "found" from
 * "ambiguous": an `id` is unique only WITHIN a partition, so a cross-partition
 * lookup can legitimately match two different documents.
 *
 * @param id - The document id
 * @param target - The resolved entity target
 * @returns The parameterized statement
 * @since 0.2.0
 */
export function buildIdLookupQuery(id: string, target: CosmosTarget): CosmosQuerySpec {
  const bag = new ParameterBag();
  const predicate = `${fieldExpression(target.primaryKey, target)} = ${bag.bind(id)}`;
  return {
    query: `SELECT * FROM ${ROOT} WHERE ${predicate} OFFSET 0 LIMIT 2`,
    parameters: bag.collect(),
  };
}

/**
 * The parameter accumulator, exported so the data source can build a statement
 * out of more than one clause helper while keeping one dense parameter list.
 *
 * @since 0.2.0
 */
export { ParameterBag };
