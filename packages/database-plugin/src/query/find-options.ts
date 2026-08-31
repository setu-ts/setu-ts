/**
 * Query option types consumed by {@linkcode IRepository} methods.
 *
 * @module
 */
import type { FilterExpression, OrderDirection } from '@setu-ts/common';

/**
 * Sort direction for a single field.
 *
 * Re-exported from `@setu-ts/common`, where it was promoted in M52c
 * alongside `NormalizedQuery` so a backend in another package can name it.
 * Same type, two import paths.
 *
 * @since 0.1.0
 */
export type {
  FilterComparison,
  FilterExpression,
  FilterOperator,
  OrderDirection,
} from '@setu-ts/common';

/**
 * Options for {@linkcode IRepository.findAll}.
 *
 * @since 0.1.0
 */
export interface FindOptions {
  /** Filter conditions keyed by field name. */
  readonly where?: Record<string, unknown>;
  /** Portable filter expression conjoined with {@linkcode where}. */
  readonly filter?: FilterExpression;
  /** Field-to-direction sort specification. */
  readonly orderBy?: Record<string, OrderDirection>;
  /** Maximum number of results to return. */
  readonly limit?: number;
  /** Number of results to skip. */
  readonly offset?: number;
  /** Select only specific fields (projection). */
  readonly select?: readonly string[];
  /**
   * A keyset cursor position, or `undefined` when the query starts at the
   * first page. Carried alongside {@linkcode offset} rather than replacing it:
   * an offset says "skip this many from the start" and a cursor says "after
   * this row", and the two are contradictory — a query carrying both is
   * refused by name (`UnsupportedQueryFeatureError`).
   */
  readonly cursor?: string;
}

/**
 * Options for {@linkcode IRepository.findPage} — the parameter shape.
 *
 * Extends {@linkcode FindOptions} with no additional members; included as a
 * distinct named type so the repository surface can document it separately
 * from the `findAll` options.
 *
 * @since 0.1.0
 */
export type PageOptions = FindOptions;

/**
 * A single page of entities returned by {@linkcode IRepository.findPage},
 * plus the cursor that continues to the next page (or `null` when the page
 * is the last).
 *
 * The typed form of {@linkcode PageResult}: `rows` carries `Entity[]` rather
 * than `Record<string, unknown>[]`.
 *
 * @typeParam Entity - The entity shape the repository manages
 * @since 0.2.0
 */
export interface Page<Entity = Record<string, unknown>> {
  /** The rows in this page, already filtered, sorted, paginated and projected. */
  readonly rows: Entity[];
  /** A cursor to fetch the next page, or `null` when no further page exists. */
  readonly nextCursor: string | null;
}

/**
 * Options for {@linkcode IRepository.count}.
 *
 * @since 0.1.0
 */
export interface CountOptions {
  /** Filter conditions applied to the count query. */
  readonly where?: Record<string, unknown>;
  /** Portable filter expression conjoined with {@linkcode where}. */
  readonly filter?: FilterExpression;
}
