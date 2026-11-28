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
 * passes its platform's version rule and builds its own response.
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

/** Which `Sec-WebSocket-Version` values a platform accepts, from the raw header. */
export type HandshakeVersionRule = (raw: string | null) => boolean;

/**
 * Node's `ws` 8.23.0 rule: the header read with unary `+`, so surrounding
 * whitespace and other numeric spellings of 13 or 8 are accepted. Deno's
 * adapter uses it, so Deno answers as Node does.
 */
export const WS_VERSION_RULE: HandshakeVersionRule = (raw) => {
  const version = Number(raw ?? undefined);
  return version === 13 || version === 8;
};

/**
 * workerd's rule: the header is exactly `13`. workerd refuses `8`, `0x0d`,
 * `+13`, `13.0`, `013`, and `13` with a vertical tab, form feed or no-break space
 * (measured on local workerd), so the Workers adapter must too, or such a
 * handshake would run `onOpen` before the platform refuses it. Not trimmed:
 * spaces and tabs are already stripped from a header value, and `trim()` would
 * also strip the vertical tab, form feed and no-break space that workerd keeps.
 */
export const WORKERD_VERSION_RULE: HandshakeVersionRule = (raw) => raw === '13';

/**
 * Checks a WebSocket handshake's key the way `ws` does, and its version by the
 * platform's own rule.
 *
 * @param headers - The upgrade request's headers
 * @param acceptsVersion - The platform's `Sec-WebSocket-Version` rule
 * @returns The refusal, or `undefined` when both headers are acceptable
 */
export function refuseHandshakeHeaders(
  headers: Headers,
  acceptsVersion: HandshakeVersionRule,
): HandshakeHeaderRefusal | undefined {
  const key = headers.get('sec-websocket-key');
  if (key === null || !KEY_PATTERN.test(key)) {
    return { header: 'key', reason: 'Missing or invalid Sec-WebSocket-Key header' };
  }
  if (!acceptsVersion(headers.get('sec-websocket-version'))) {
    return { header: 'version', reason: 'Missing or invalid Sec-WebSocket-Version header' };
  }
  return undefined;
}
