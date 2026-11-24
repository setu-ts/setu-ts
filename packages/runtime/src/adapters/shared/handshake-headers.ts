/**
 * The handshake header rules Node's `ws` applies, for adapters whose platform
 * does not.
 *
 * `ws` 8.23.0 (`websocket-server.js`) refuses a `Sec-WebSocket-Key` that is
 * not 16 bytes of base64 and a `Sec-WebSocket-Version` that is neither 13 nor
 * 8, both with 400, naming the versions it speaks on the second. `Deno.upgradeWebSocket`
 * checks only that a key is present, so without these rules Deno upgraded a
 * malformed key or a missing version that Node refuses (V13-276). Version 8 is
 * accepted, as `ws` accepts it.
 *
 * @module
 * @internal
 */

/** A 16-byte nonce in base64: 22 characters and the `==` padding. */
const KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/;

/** Why a handshake's headers are refused, and the headers the 400 carries. */
export interface HandshakeHeaderRefusal {
  /** The reason, for the connection's close event. */
  readonly reason: string;
  /** Headers for the 400 response. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Checks a WebSocket handshake's key and version the way `ws` does.
 *
 * @param headers - The upgrade request's headers
 * @returns The refusal, or `undefined` when both headers are acceptable
 */
export function refuseHandshakeHeaders(headers: Headers): HandshakeHeaderRefusal | undefined {
  const key = headers.get('sec-websocket-key');
  if (key === null || !KEY_PATTERN.test(key)) {
    return { reason: 'Missing or invalid Sec-WebSocket-Key header', headers: {} };
  }
  // `ws` reads the version with unary `+`, so surrounding whitespace is
  // accepted and anything non-numeric, or absent, is `NaN`.
  const version = Number(headers.get('sec-websocket-version') ?? undefined);
  if (version !== 13 && version !== 8) {
    return {
      reason: 'Missing or invalid Sec-WebSocket-Version header',
      headers: { 'sec-websocket-version': '13, 8' },
    };
  }
  return undefined;
}
