/**
 * The handshake header rules Node's `ws` applies, for adapters whose platform
 * does not apply them before framework code runs.
 *
 * `ws` 8.23.0 (`websocket-server.js`) refuses a `Sec-WebSocket-Key` that is
 * not 16 bytes of base64 and a `Sec-WebSocket-Version` it does not speak.
 * `Deno.upgradeWebSocket` checks only that a key is present, so Deno upgraded a
 * malformed key or a missing version that Node refuses (V13-276). workerd
 * checks the handshake only after the Worker has accepted the socket pair, so a
 * malformed handshake ran a route's `onOpen` there (V13-278). Each adapter
 * passes the versions its platform speaks and builds its own response.
 *
 * @module
 * @internal
 */

/** A 16-byte nonce in base64: 22 characters and the `==` padding. */
const KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/;

/** Which handshake header is refused, and why. */
export interface HandshakeHeaderRefusal {
  /** The header at fault: the key is checked first, as `ws` does. */
  readonly header: 'key' | 'version';
  /** The reason, for the connection's close event. */
  readonly reason: string;
}

/**
 * Checks a WebSocket handshake's key and version the way `ws` does.
 *
 * @param headers - The upgrade request's headers
 * @param versions - The `Sec-WebSocket-Version` values the platform speaks
 * @returns The refusal, or `undefined` when both headers are acceptable
 */
export function refuseHandshakeHeaders(
  headers: Headers,
  versions: readonly number[],
): HandshakeHeaderRefusal | undefined {
  const key = headers.get('sec-websocket-key');
  if (key === null || !KEY_PATTERN.test(key)) {
    return { header: 'key', reason: 'Missing or invalid Sec-WebSocket-Key header' };
  }
  // `ws` reads the version with unary `+`, so surrounding whitespace is
  // accepted and anything non-numeric, or absent, is `NaN`.
  const version = Number(headers.get('sec-websocket-version') ?? undefined);
  if (!versions.includes(version)) {
    return { header: 'version', reason: 'Missing or invalid Sec-WebSocket-Version header' };
  }
  return undefined;
}
