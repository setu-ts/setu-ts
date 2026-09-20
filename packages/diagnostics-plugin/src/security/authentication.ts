/**
 * Canonical authenticated bytes and the standard HMAC/SHA-256 primitives.
 *
 * Every signed protocol byte is defined HERE, once, and both the connector
 * and the native client consume these same builders — the server and client
 * cannot drift apart silently, and the independent fixed-vector tests in
 * `test/unit/authentication.test.ts` pin the canonicalization itself so a
 * shared bug cannot become the only evidence.
 *
 * @module
 */

/**
 * The protocol version domain. The FIRST line of every MAC input; request
 * and response domains differ in the SECOND line, which prevents reflecting
 * a request MAC as a response MAC (or vice versa).
 *
 * @internal
 */
export const MAC_DOMAIN = 'setu-diagnostics-v1';

/**
 * The canonical request-MAC input fields, in order. `instance` is the empty
 * string on the initial status request and the bound instance UUID on every
 * later request. Joined with `\n`, with NO final newline.
 *
 * @internal
 */
export function requestMacFields(
  sessionId: string,
  instance: string,
  sequence: string,
  authority: string,
  canonicalTarget: string,
): readonly string[] {
  return [
    MAC_DOMAIN,
    'request',
    sessionId,
    instance,
    sequence,
    'GET',
    authority,
    canonicalTarget,
  ];
}

/**
 * The canonical response-MAC input fields, in order. `sequence` is exactly
 * the accepted request's `X-Setu-Sequence` value — there is no response
 * counter.
 *
 * @internal
 */
export function responseMacFields(
  sessionId: string,
  instanceId: string,
  sequence: string,
  canonicalTarget: string,
  statusCode: string,
  bodySha256Hex: string,
): readonly string[] {
  return [
    MAC_DOMAIN,
    'response',
    sessionId,
    instanceId,
    sequence,
    canonicalTarget,
    statusCode,
    bodySha256Hex,
  ];
}

const ENCODER = new TextEncoder();

/**
 * Joins the canonical fields with `\n` (no final newline) and encodes them
 * as UTF-8. Field VALUES themselves must never contain `\n`; every field
 * this protocol uses is validated to a grammar (`hex`, decimal, UUID,
 * fixed paths) that excludes it before the fields are built.
 *
 * @param fields - The canonical fields, in order
 * @returns The exact bytes the MAC covers
 * @internal
 */
export function canonicalBytes(fields: readonly string[]): Uint8Array {
  return ENCODER.encode(fields.join('\n'));
}

/**
 * Encodes bytes as lowercase hex.
 *
 * @param bytes - The bytes to encode
 * @returns The lowercase hex string
 * @internal
 */
export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte < 16 ? `0${byte.toString(16)}` : byte.toString(16);
  }
  return out;
}

const MAC_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parses a 64-character lowercase hex MAC. Anything else — uppercase, short,
 * long, non-hex — is `null`, and the caller refuses BEFORE any crypto.
 *
 * @param value - The header value to parse
 * @returns The 32 MAC bytes, or `null` for a malformed value
 * @internal
 */
export function parseMac(value: string): Uint8Array | null {
  if (!MAC_PATTERN.test(value)) {
    return null;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Imports a raw session key as a NON-extractable HMAC-SHA-256
 * sign/verify key. The function copies the caller's bytes, imports from the
 * copy, and zeroes the copy afterwards — the temporary raw material this
 * module owns never outlives the import. No promise is made about
 * caller-owned copies or garbage-collected memory.
 *
 * @param subtle - The Web Crypto SubtleCrypto to use
 * @param raw - The 32-byte session key
 * @returns The imported key
 * @throws {Error} When the runtime refuses the import
 * @internal
 */
export async function importSessionKey(
  subtle: SubtleCrypto,
  raw: Uint8Array,
): Promise<CryptoKey> {
  const copy = new Uint8Array(raw);
  try {
    return await subtle.importKey(
      'raw',
      copy as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  } finally {
    copy.fill(0);
  }
}

/**
 * Signs canonical fields with the session key.
 *
 * @param subtle - The Web Crypto SubtleCrypto to use
 * @param key - The imported session key
 * @param fields - The canonical fields, in order
 * @returns The lowercase hex MAC
 * @internal
 */
export async function signFields(
  subtle: SubtleCrypto,
  key: CryptoKey,
  fields: readonly string[],
): Promise<string> {
  const signature = await subtle.sign('HMAC', key, canonicalBytes(fields) as BufferSource);
  return hexEncode(new Uint8Array(signature));
}

/**
 * Verifies a MAC over canonical fields via `subtle.verify` — never string
 * equality.
 *
 * @param subtle - The Web Crypto SubtleCrypto to use
 * @param key - The imported session key
 * @param macHex - The presented MAC header value
 * @param fields - The canonical fields, in order
 * @returns `true` only when the MAC verifies
 * @internal
 */
export async function verifyFields(
  subtle: SubtleCrypto,
  key: CryptoKey,
  macHex: string,
  fields: readonly string[],
): Promise<boolean> {
  const mac = parseMac(macHex);
  if (mac === null) {
    return false;
  }
  return await subtle.verify(
    'HMAC',
    key,
    mac as BufferSource,
    canonicalBytes(fields) as BufferSource,
  );
}

/**
 * Computes the lowercase hex SHA-256 of exact bytes — the response-body
 * digest a signed response carries.
 *
 * @param subtle - The Web Crypto SubtleCrypto to use
 * @param bytes - The exact body bytes
 * @returns The lowercase hex digest
 * @internal
 */
export async function sha256Hex(subtle: SubtleCrypto, bytes: Uint8Array): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return hexEncode(new Uint8Array(digest));
}
