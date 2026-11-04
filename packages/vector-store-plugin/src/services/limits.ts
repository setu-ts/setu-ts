/**
 * The limits every adapter honours, chosen as the tightest backend's so a
 * call behaves the same everywhere (plan §3.2, §3.5, §3.6, §3.10).
 *
 * @module
 */

/** Largest declared vector length; an adapter may support fewer. */
export const MAX_DIMENSIONS = 4096;
/** Filterable fields per collection (Vectorize allows 10 metadata indexes). */
export const MAX_FILTERABLE_FIELDS = 10;
/** Matches per query (Vectorize's limit when metadata is returned). */
export const MAX_TOP_K = 50;
/** Records per `upsert` or `replaceSource` (pgvector's bind-parameter budget). */
export const MAX_RECORDS_PER_CALL = 500;
/** Ids per `delete`. */
export const MAX_IDS_PER_CALL = 1000;
/** UTF-8 bytes in a scope (Vectorize's namespace limit). */
export const MAX_SCOPE_BYTES = 64;
/** UTF-8 bytes in a record or source id. */
export const MAX_ID_BYTES = 256;
/** UTF-8 bytes in a record's content (inside Vectorize's 10 KiB metadata cap). */
export const MAX_CONTENT_BYTES = 8192;
/**
 * The largest finite float32. pgvector, Qdrant and Vectorize store float32, so a
 * larger component would become infinite in the backend.
 */
export const MAX_FLOAT32 = 3.4028234663852886e38;
/** UTF-8 bytes in a string metadata or filter value (Vectorize indexes only the first 64). */
export const MAX_STRING_VALUE_BYTES = 64;
/** Values in one `in` clause. */
export const MAX_IN_VALUES = 100;
/** Nesting depth of `and` clauses. */
export const MAX_FILTER_DEPTH = 4;
/** Clauses in one filter, counting every node. */
export const MAX_FILTER_CLAUSES = 32;

const encoder = new TextEncoder();

/**
 * The UTF-8 byte length of a string.
 *
 * @param value - The string
 * @returns Its encoded length
 */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Whether a value is a non-empty, well-formed string of at most `max` UTF-8 bytes.
 *
 * @param value - The value to check
 * @param max - The byte limit
 * @returns True when it qualifies
 */
export function isBoundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.isWellFormed() && utf8Bytes(value) <= max
  );
}
