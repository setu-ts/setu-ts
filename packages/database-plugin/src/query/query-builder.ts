/**
 * Translates {@linkcode FindOptions} into an adapter-specific query
 * representation that the in-memory adapter can evaluate.
 *
 * @module
 */
import type { CountOptions, FindOptions, OrderDirection } from './find-options.ts';

/**
 * Normalized query representation that adapters can evaluate.
 *
 * @since 0.1.0
 */
export interface NormalizedQuery {
  /** Filter conditions. */
  readonly where: Record<string, unknown>;
  /** Field-to-direction sort specification. */
  readonly orderBy: Record<string, OrderDirection>;
  /** Maximum results or `-1` for unlimited. */
  readonly limit: number;
  /** Skip count. */
  readonly offset: number;
  /** Field projection (empty means all fields). */
  readonly select: readonly string[];
}

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
    orderBy: options?.orderBy ?? {},
    limit: options?.limit ?? UNLIMITED,
    offset: options?.offset ?? 0,
    select: options?.select ?? [],
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
