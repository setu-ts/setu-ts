/** A tenant-separated, fixed-length key for a vector record. @module */

const encoder = new TextEncoder();

/**
 * Hashes a record's scope and id into 64 lowercase hex characters. Adapters
 * whose ids are global to an index (Vectorize) or must be UUIDs (Qdrant) store
 * this instead of the caller's id, so two tenants writing the same id never
 * touch each other's record. Each part is length-prefixed before hashing
 * (`<len>:<scope>|<len>:<id>`), so no choice of scope and id can produce
 * another pair's input.
 *
 * @param subtle - Web Crypto, from `IRuntimeServices.subtle`
 * @param scope - The tenant scope
 * @param id - The record id
 * @returns The SHA-256 digest as 64 hex characters
 * @example
 * ```typescript
 * const key = await vectorRecordKey(runtime.subtle, 'tenant-a', 'doc-1#0');
 * ```
 * @since 0.12.0
 */
export async function vectorRecordKey(
  subtle: SubtleCrypto,
  scope: string,
  id: string,
): Promise<string> {
  const input = `${scope.length}:${scope}|${id.length}:${id}`;
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(input)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
