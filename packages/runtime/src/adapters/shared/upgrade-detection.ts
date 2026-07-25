/**
 * Shared WebSocket upgrade detection — the single `Upgrade: websocket` check
 * every HTTP adapter uses before consulting its upgrade router.
 *
 * Kept in one place so the four adapters cannot drift apart on header casing
 * or on the comma-separated `Connection` form (AI_GUIDELINES §11.1).
 *
 * @module
 * @since 0.2.0
 */

/**
 * Reports whether a set of request headers describes an RFC 6455 WebSocket
 * upgrade.
 *
 * Both conditions are required, per RFC 6455 §4.2.1: `Upgrade` must equal
 * `websocket` (case-insensitively), and `Connection` must contain the `upgrade`
 * token. `Connection` is a comma-separated list — proxies routinely send
 * `keep-alive, Upgrade` — so it is matched token-wise rather than by equality.
 *
 * @param headers - The request headers
 * @returns `true` when the request asks for a WebSocket upgrade
 * @example
 * ```typescript
 * if (isWebSocketUpgradeRequest(request.headers)) {
 *   // consult the upgrade router before touching the body
 * }
 * ```
 * @since 0.2.0
 */
export function isWebSocketUpgradeRequest(headers: Headers): boolean {
  const upgrade = headers.get('upgrade');
  if (upgrade === null || upgrade.trim().toLowerCase() !== 'websocket') {
    return false;
  }

  const connection = headers.get('connection');
  if (connection === null) {
    return false;
  }

  return connection
    .split(',')
    .some((token) => token.trim().toLowerCase() === 'upgrade');
}
