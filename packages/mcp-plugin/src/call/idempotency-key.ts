/** Stable request keys scoped by the idempotency plugin to the principal. @module */

/** Canonical JSON: recursively sorts object keys while preserving array order. */
export function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (typeof entry === 'object' && entry !== null)
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
      );
    return entry;
  };
  return JSON.stringify(sort(value));
}

/** Derives the tool key with the runtime's Web Crypto implementation. */
export async function idempotencyKey(
  name: string,
  args: unknown,
  subtle: SubtleCrypto,
): Promise<string> {
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson([name, args]))),
  );
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += alphabet[(buffer >>> bits) & 63];
    }
  }
  // SHA-256 always leaves four bits after the first 42 base64url characters.
  encoded += alphabet[(buffer << (6 - bits)) & 63];
  return `mcp-${encoded}`;
}
