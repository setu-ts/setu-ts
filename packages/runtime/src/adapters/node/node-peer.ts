/**
 * The peer address a listener records for a request whose socket cannot
 * report one (M139b §3.4).
 *
 * Kept free of `node:` imports so the adapter can read it without loading the
 * HTTP/2 listener module, which is imported only when `http2` is set.
 *
 * @module
 */

/**
 * Property key under which the cleartext HTTP/2 listener stamps the client's
 * address on each incoming request. Node hands an HTTP/2 server that was given
 * a JS stream (the shared-port hand-off) a wrapper socket with no peer, so
 * `incoming.socket.remoteAddress` is `undefined` there (probed); the listener
 * records the real socket's address per session instead.
 *
 * @internal
 */
export const PEER_ADDRESS: unique symbol = Symbol('setu.runtime.peerAddress');

/** The parts of a Node incoming request the peer lookup reads. */
export interface PeerCarrier {
  readonly [PEER_ADDRESS]?: string | undefined;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/**
 * Resolves the client address of a Node incoming request: the address the
 * listener recorded, else the socket's own.
 *
 * @param incoming - The node-server `incoming` request, when served by it
 * @returns The peer address, or `undefined` when neither source has one
 * @internal
 */
export function peerAddressOf(incoming: PeerCarrier | undefined): string | undefined {
  return incoming?.[PEER_ADDRESS] ?? incoming?.socket?.remoteAddress;
}
