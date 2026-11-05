/**
 * Qdrant filter translation. Every request carries the scope as a `must`
 * condition; numbers compare through `range` (never `match`, whose float
 * handling is not relied on); anything outside the filter type throws.
 *
 * @module
 */
import type { VectorFilter } from '@setu-ts/common';

/** A Qdrant field condition or nested filter, as the REST API takes it. */
export type QdrantCondition = Readonly<Record<string, unknown>>;

/** A Qdrant filter body. */
export interface QdrantFilter {
  readonly must: readonly QdrantCondition[];
  readonly must_not?: readonly QdrantCondition[];
}

/** Payload key holding the tenant scope. */
export const SCOPE_KEY = 'scope';
/** Payload key holding the record's source. */
export const SOURCE_KEY = 'source_id';
/** Payload key holding the caller's record id. */
export const ID_KEY = 'id';
/** Payload key holding the record's content. */
export const CONTENT_KEY = 'content';
/** Payload key holding the record's metadata object. */
export const METADATA_KEY = 'metadata';
/** The payload key holding a versioned `replaceSource`'s version. */
export const VERSION_KEY = 'source_version';

/**
 * The condition that pins a request to one scope.
 *
 * @param scope - The tenant scope
 * @returns The condition
 */
export function scopeCondition(scope: string): QdrantCondition {
  return { key: SCOPE_KEY, match: { value: scope } };
}

/**
 * A scope-pinned filter, optionally narrowed by a validated vector filter.
 *
 * @param scope - The tenant scope
 * @param filter - A validated filter
 * @returns The filter body
 */
export function scopedFilter(scope: string, filter?: VectorFilter): QdrantFilter {
  return {
    must: [scopeCondition(scope), ...(filter === undefined ? [] : [translate(filter)])],
  };
}

/**
 * Translates a validated filter. Field keys address `metadata.<field>`; the
 * field-name grammar excludes the `.` and `[]` Qdrant would read as paths.
 *
 * @param filter - A validated filter
 * @returns The condition
 */
export function translate(filter: VectorFilter): QdrantCondition {
  if ('and' in filter) return { must: filter.and.map(translate) };
  const key = `${METADATA_KEY}.${filter.field}`;
  switch (filter.op) {
    case 'eq':
      return typeof filter.value === 'number'
        ? { key, range: { gte: filter.value, lte: filter.value } }
        : { key, match: { value: filter.value } };
    case 'in': {
      const values = filter.value;
      if (values.every((value) => typeof value === 'string')) {
        return { key, match: { any: values } };
      }
      return { should: values.map((value) => ({ key, range: { gte: value, lte: value } })) };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return { key, range: { [filter.op]: filter.value } };
    default:
      throw new TypeError(
        `qdrant: unsupported filter operator '${String((filter as { op: unknown }).op)}'`,
      );
  }
}
