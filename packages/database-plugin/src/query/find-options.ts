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
