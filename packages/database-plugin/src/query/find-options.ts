/**
 * Query option types consumed by {@linkcode IRepository} methods.
 *
 * @module
 */

/**
 * Sort direction for a single field.
 *
 * @since 0.1.0
 */
export type OrderDirection = 'asc' | 'desc';

/**
 * Options for {@linkcode IRepository.findAll}.
 *
 * @since 0.1.0
 */
export interface FindOptions {
  /** Filter conditions keyed by field name. */
  readonly where?: Record<string, unknown>;
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
}
