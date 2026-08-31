/**
 * Translates {@linkcode FindOptions} into an adapter-specific query
 * representation that the in-memory adapter can evaluate.
 *
 * @module
 */
import type { FilterExpression, NormalizedQuery, OrderDirection } from '@setu-ts/common';
import type { CountOptions, FindOptions, PageOptions } from './find-options.ts';

/**
 * Normalized query representation that adapters can evaluate.
 *
 * Re-exported from `@setu-ts/common`, where it was promoted in M52c
 * so a backend in another package can name the type its `findAll` receives.
 * Before the promotion this type was reachable only through an internal path
 * while the exported `DataSource` interface referenced it — so a consumer
 * could not annotate against it at all.
 *
 * @since 0.1.0
 */
export type { NormalizedQuery };

/** Default limit when none is specified (unbounded). */
const UNLIMITED = -1;

/**
 * Normalize {@linkcode FindOptions} into a {@linkcode NormalizedQuery} with
 * all optionals resolved to concrete defaults.
 *
 * @param options - Optional find options
 * @returns Fully populated normalized query
 * @since 0.1.0
 */
export function normalizeQuery(options?: FindOptions): NormalizedQuery {
  return {
    where: options?.where ?? {},
    ...(options?.filter === undefined ? {} : { filter: options.filter }),
    orderBy: options?.orderBy ?? {},
    limit: options?.limit ?? UNLIMITED,
    offset: options?.offset ?? 0,
    select: options?.select ?? [],
  };
}

/**
 * Refusal type returned by {@linkcode normalizePageQuery} when the query carries
 * both a non-zero offset and a cursor (§3.10). Carried as an error rather than a
 * throw so callers using `.catch()` on the Promise-returning
 * {@linkcode IRepository.findPage} see a proper rejection.
 *
 * @since 0.2.0
 */
export class PageNormalizationError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'PageNormalizationError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Normalize {@linkcode PageOptions} into a {@linkcode NormalizedQuery} with
 * every optional resolved to a concrete default, plus a refusal when both a
 * non-zero {@linkcode offset} and a {@linkcode cursor} are present.
 *
 * A cursor says "after this row"; an offset says "skip this many from the
 * start". Honouring both would require inventing a composition rule no backend
 * has, so refusing is the only answer that cannot be wrong (§3.10). The refusal
 * is returned (not thrown) so the caller's `Promise`-returning
 * {@linkcode IRepository.findPage} can reject it — a synchronous throw there
 * would bypass a caller using `.catch()`, which is the defect class documented
 * at {@linkcode unknownColumnError}.
 *
 * @param options - Optional page find options
 * @returns The normalized query, or a {@linkcode PageNormalizationError} when
 * the query is invalid
 * @since 0.2.0
 */
export function normalizePageQuery(
  options?: PageOptions,
): NormalizedQuery | PageNormalizationError {
  const offset = options?.offset ?? 0;
  const hasCursor = options?.cursor !== undefined;
  if (offset !== 0 && hasCursor) {
    return new PageNormalizationError(
      `cursor-pagination: offset=${offset} conflicts with cursor; use one or the other`,
    );
  }
  return {
    where: options?.where ?? {},
    ...(options?.filter === undefined ? {} : { filter: options.filter }),
    orderBy: options?.orderBy ?? {},
    limit: options?.limit ?? UNLIMITED,
    offset,
    select: options?.select ?? [],
    ...(hasCursor ? { cursor: options.cursor } : {}),
  };
}

/**
 * Normalize {@linkcode CountOptions} into a filter map.
 *
 * @param options - Optional count options
 * @returns Filter conditions (empty when no where clause)
 * @since 0.1.0
 */
export function normalizeCountOptions(options?: CountOptions): Record<string, unknown> {
  return options?.where ?? {};
}

/**
 * Evaluate a single {@linkcode NormalizedQuery.where} condition against an
 * entity. Every key in the filter must match the corresponding property on
 * the entity (strict equality).
 *
 * @param entity - The entity to test
 * @param where - Normalized filter conditions
 * @returns `true` when all conditions match
 * @since 0.1.0
 */
export function matchesWhere<Entity extends Record<string, unknown>>(
  entity: Entity,
  where: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (entity[key] !== expected) {
      return false;
    }
  }
  return true;
}

/** Resolves a value from an entity by walking a path. */
function resolveEntityPath<Entity extends Record<string, unknown>>(
  entity: Entity,
  path: string | readonly string[],
): unknown {
  const segments = Array.isArray(path) ? path : [path];
  let current: unknown = entity;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Evaluates one portable filter expression against an in-memory entity. */
export function matchesFilter<Entity extends Record<string, unknown>>(
  entity: Entity,
  filter: FilterExpression,
): boolean {
  if (filter.type !== 'comparison') {
    return filter.type === 'and'
      ? filter.filters.every((child) => matchesFilter(entity, child))
      : filter.filters.some((child) => matchesFilter(entity, child));
  }

  const actual = resolveEntityPath(entity, filter.field);
  switch (filter.operator) {
    case 'eq':
      return actual === filter.value;
    case 'contains':
      return typeof actual === 'string' && typeof filter.value === 'string' &&
        actual.includes(filter.value);
    case 'gt':
      return comparableGreaterThan(actual, filter.value);
    case 'gte':
      return comparableEquals(actual, filter.value) || comparableGreaterThan(actual, filter.value);
    case 'lt':
      return comparableGreaterThan(filter.value, actual);
    case 'lte':
      return comparableEquals(actual, filter.value) || comparableGreaterThan(filter.value, actual);
    case 'in':
      return filter.value.some((candidate) => actual === candidate);
  }
}

/**
 * Equality for the inclusive comparisons, where `===` is wrong for a `Date`.
 *
 * Two `Date` instances for the same instant are never `===`, so `gte`/`lte`
 * dropped the boundary row of every date range — the inclusive half of the
 * `Date` widening was inoperative while the strict half worked.
 */
function comparableEquals(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function comparableGreaterThan(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() > right.getTime();
  }
  return typeof left === 'number' && typeof right === 'number' && left > right ||
    typeof left === 'string' && typeof right === 'string' && left > right;
}

/**
 * Sort an array of entities according to a {@linkcode NormalizedQuery.orderBy}
 * specification.
 *
 * @param entities - Entities to sort
 * @param orderBy - Field-to-direction mapping
 * @returns New sorted array
 * @since 0.1.0
 */
export function applyOrderBy<Entity extends Record<string, unknown>>(
  entities: Entity[],
  orderBy: Record<string, OrderDirection>,
): Entity[] {
  if (Object.keys(orderBy).length === 0) {
    return entities;
  }

  const sorted = [...entities];
  sorted.sort((a, b) => {
    for (const [field, direction] of Object.entries(orderBy)) {
      const av = a[field];
      const bv = b[field];
      if (av === bv) continue;
      if (av === undefined || bv === undefined) {
        // Push undefined values to the end regardless of direction.
        return av === undefined ? 1 : -1;
      }
      if (av === null || bv === null) {
        return av === null ? 1 : -1;
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (direction === 'desc') return -cmp;
      return cmp;
    }
    return 0;
  });
  return sorted;
}

/**
 * Apply pagination (offset + limit) to an array.
 *
 * @param entities - Full result set
 * @param offset - Items to skip
 * @param limit - Maximum items (`-1` means unlimited)
 * @returns Paginated slice
 * @since 0.1.0
 */
export function applyPagination<T>(entities: T[], offset: number, limit: number): T[] {
  const start = offset > 0 ? offset : 0;
  const sliced = entities.slice(start);
  if (limit > 0) {
    return sliced.slice(0, limit);
  }
  return sliced;
}

/**
 * Project an entity to only the fields listed in {@linkcode select}.
 *
 * @param entity - Source entity
 * @param select - Fields to include (empty means all)
 * @returns Projected entity
 * @since 0.1.0
 */
export function projectFields<Entity extends Record<string, unknown>>(
  entity: Entity,
  select: readonly string[],
): Partial<Entity> {
  if (select.length === 0) {
    return { ...entity } as Partial<Entity>;
  }
  const projected: Partial<Entity> = {};
  for (const field of select) {
    if (field in entity) {
      projected[field as keyof Entity] = entity[field] as Entity[keyof Entity];
    }
  }
  return projected;
}

/**
 * The columns an in-memory entity store has actually been shown — the union of
 * own keys across every row it currently holds.
 *
 * This is the only schema an adapter that was never given one can have. It is
 * a union rather than the first row's keys because a sparse optional column
 * appears on some rows and not others, and treating the first row as
 * authoritative would reject a real column.
 *
 * Not exported: {@linkcode unknownColumnError} is its only caller, and an
 * export whose sole other reader is its own test is dead surface.
 *
 * @param rows - The rows currently visible for the entity
 * @returns Every key seen on at least one row
 * @since 0.2.0
 */
function observedColumns(
  rows: readonly Record<string, unknown>[],
): ReadonlySet<string> {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }
  return columns;
}

/**
 * Report a `select` or `orderBy` field that no stored row carries.
 *
 * The Drizzle and Prisma adapters reject an unknown column by name; the memory
 * adapter used to accept one silently, so a projection quietly lost a field
 * and a sort quietly returned rows unordered — a 200 in development and a 500
 * on the same call in production. Only `select` and `orderBy` are checked:
 * both are meaningless against a column no row has, whereas a `where` or
 * `filter` on one is an ordinary "no row matches" query, and the memory
 * adapter cannot tell an unknown column from one that is absent everywhere.
 *
 * An entity holding **no rows at all** is skipped. There is nothing to observe
 * and nothing to return, so the check could only produce a false refusal.
 *
 * This RETURNS the error rather than throwing it, because every caller sits
 * behind a `Promise`-returning data-source method: a synchronous throw there
 * bypasses a caller using `.catch()`, which is a defect this repository has
 * shipped more than once.
 *
 * @param entity - Entity name, quoted in the diagnostic
 * @param rows - The rows currently visible for the entity
 * @param query - The normalized query whose `select` and `orderBy` are checked
 * @returns The error naming the entity, the clause and the offending field, or
 * `undefined` when every named field is known
 * @since 0.2.0
 */
export function unknownColumnError(
  entity: string,
  rows: readonly Record<string, unknown>[],
  query: Pick<NormalizedQuery, 'orderBy' | 'select'>,
): Error | undefined {
  const fields = [
    ...query.select.map((field) => ['select', Array.isArray(field) ? field[0] : field] as const),
    ...Object.keys(query.orderBy).map((field) =>
      ['orderBy', Array.isArray(field) ? field[0] : field] as const
    ),
  ];
  if (fields.length === 0 || rows.length === 0) return undefined;

  const known = observedColumns(rows);
  for (const [clause, field] of fields) {
    if (!known.has(field)) {
      return new Error(
        `Memory adapter: entity '${entity}' has no '${field}' column for ${clause}. ` +
          `Known columns: ${[...known].sort().join(', ')}.`,
      );
    }
  }
  return undefined;
}
