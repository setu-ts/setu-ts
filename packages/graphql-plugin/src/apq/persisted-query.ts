/**
 * APQ (Automatic Persisted Queries) — pure extraction and hash functions.
 *
 * @module
 * @since 0.3.0
 */

/**
 * Extract persisted query info from request extensions.
 *
 * Returns `null` when extensions are absent, `persistedQuery` is missing/
 * malformed, or the version is not `1`.
 *
 * @param extensions - The request extensions object
 * @returns The persisted query info, or `null`
 */
export function extractPersistedQuery(
  extensions?: Record<string, unknown>,
): { version: number; sha256Hash: string } | null {
  if (extensions === undefined || typeof extensions !== 'object') {
    return null;
  }
  const pq = extensions.persistedQuery;
  if (pq === undefined || pq === null || typeof pq !== 'object') {
    return null;
  }
  const pqObj = pq as Record<string, unknown>;
  const version = pqObj.version;
  const sha256Hash = pqObj.sha256Hash;
  if (typeof version !== 'number' || version !== 1) {
    return null;
  }
  if (typeof sha256Hash !== 'string' || sha256Hash.length === 0) {
    return null;
  }
  return { version, sha256Hash };
}

/**
 * Compute a SHA-256 hash of the query string and return lowercase hex.
 *
 * Takes a {@linkcode SubtleCrypto} instance (from `runtime.subtle`), never
 * uses a global or runtime-specific API.
 *
 * @param query - The query string to hash
 * @param subtle - The SubtleCrypto instance
 * @returns The lowercase hex hash
 */
export async function persistedQueryHash(
  query: string,
  subtle: SubtleCrypto,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(query);
  const hashBuffer = await subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
