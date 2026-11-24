/**
 * Cloudflare Workers WebSocket upgrade — completes a handshake with
 * `new WebSocketPair()` and answers with the 101 response Workers expects.
 *
 * Workers has no socket model (`listen` throws by design), so `fetch` is the
 * only path an upgrade can travel. The pair factory and the response factory
 * are injectable so every branch is unit-testable off-Workers, which is the
 * only way this module clears the per-file coverage bar.
 *
 * @module
 * @since 0.2.0
 */

import type { WebSocketEventSink, WebSocketReadyState } from '@setu-ts/common';
import type { WebSocketLike } from '../shared/web-socket-transport.ts';
import { normalizeFrame, toTransportError } from '../shared/web-socket-transport.ts';

/**
 * The server half of a Workers `WebSocketPair`. Workers sockets are driven with
 * `addEventListener` after an explicit `accept()`, not with `on*` properties.
 *
 * @since 0.2.0
 */
export interface CloudflareServerSocket extends WebSocketLike {
  /** Puts the server socket into the accepted state so it can send and receive. */
  accept(): void;
  /**
   * Subscribes to a socket event.
   *
   * @param type - Event name
   * @param listener - Event listener
   */
  addEventListener(type: string, listener: (event: never) => void): void;
}

/**
 * A created `WebSocketPair`: the client half travels back in the 101 response,
 * the server half stays here.
 *
 * @since 0.2.0
 */
export interface CloudflareWebSocketPair {
  /** The half handed to the client in the response. */
  readonly client: unknown;
  /** The half the server keeps. */
  readonly server: CloudflareServerSocket;
}

/**
 * Injectable seam covering the two Workers-only globals this upgrader needs.
 *
 * @since 0.2.0
 */
export interface CloudflareWebSocketHost {
  /**
   * Creates a linked client/server socket pair.
   *
   * @returns The pair
   */
  createPair(): CloudflareWebSocketPair;
  /**
   * Builds the 101 response that hands the client half back to the peer.
   *
   * @param client - The client half of the pair
   * @param protocol - The negotiated subprotocol to echo, when one was selected
   * @returns The 101 response
   */
  createUpgradeResponse(client: unknown, protocol?: string): Response;
}

/** Shape of the Workers `WebSocketPair` constructor on `globalThis`. */
interface WebSocketPairGlobal {
  WebSocketPair?: new () => Record<string, CloudflareServerSocket>;
}

/**
 * The `ResponseInit` a Workers WebSocket handshake answers with.
 *
 * `webSocket` is a Workers-specific member absent from the web-standard
 * `ResponseInit`; only the Workers runtime reads it, and other runtimes drop it
 * when constructing a `Response`. It is built here as a plain object so the
 * wiring is assertable off-Workers, where a round-trip through `new Response()`
 * would silently discard it.
 *
 * @since 0.2.0
 */
export interface CloudflareUpgradeResponseInit {
  /** Always `101 Switching Protocols`. */
  readonly status: 101;
  /** Carries the echoed subprotocol, when one was negotiated. */
  readonly headers: Headers;
  /** The client half of the pair, handed back to the peer. */
  readonly webSocket: unknown;
}

/**
 * Builds the 101 response init for a Workers handshake.
 *
 * @param client - The client half of the `WebSocketPair`
 * @param protocol - The negotiated subprotocol to echo, when one was selected
 * @returns The response init
 * @since 0.2.0
 */
export function buildUpgradeResponseInit(
  client: unknown,
  protocol?: string,
): CloudflareUpgradeResponseInit {
  const headers = new Headers();
  if (protocol !== undefined) {
    headers.set('sec-websocket-protocol', protocol);
  }
  return { status: 101, headers, webSocket: client };
}

/**
 * Builds the default host from the real Workers globals.
 *
 * Exported as a factory rather than a constant so the boundary cast is only
 * evaluated when an upgrade actually happens, and so a unit test can call it
 * directly to cover the default path.
 *
 * @returns A host backed by the `WebSocketPair` global
 * @throws {Error} If `WebSocketPair` is not available in the current runtime
 * @since 0.2.0
 */
export function createDefaultCloudflareWebSocketHost(): CloudflareWebSocketHost {
  return {
    createPair(): CloudflareWebSocketPair {
      // The ONE sanctioned boundary cast for this module, matching the pattern
      // cf-runtime.ts uses for Workers-only globals.
      const ctor = (globalThis as WebSocketPairGlobal).WebSocketPair;
      if (ctor === undefined) {
        throw new Error(
          'WebSocketPair is not available — WebSocket upgrades require the Cloudflare Workers runtime',
        );
      }
      const pair = new ctor();
      const client = pair[0];
      const server = pair[1];
      if (client === undefined || server === undefined) {
        throw new Error('WebSocketPair did not produce a client/server pair');
      }
      return { client, server };
    },
    createUpgradeResponse(client: unknown, protocol?: string): Response {
      // The init carries the Workers-only `webSocket` member, so it is cast at
      // this one boundary to satisfy the web-standard `ResponseInit` type.
      const init = buildUpgradeResponseInit(client, protocol) as unknown as ResponseInit;
      return new Response(null, init);
    },
  };
}

/**
 * workerd's ceiling for one incoming WebSocket message: 32 MiB. A larger
 * message closes the socket with 1009; there is no setting to raise it.
 * @since 0.14.0
 */
export const WORKERS_WS_MAX_MESSAGE_BYTES: number = 32 * 1024 * 1024;

/**
 * Close codes a peer may send, so the adapter may echo them in its reply.
 * Every other code (the reserved 1004, 1005, 1006 and 1015, the unassigned
 * 1016–2999, anything out of range) is answered with 1000: workerd throws for
 * them, and a swallowed throw would leave the peer waiting for a reply.
 */
function replyCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

/**
 * Binds a Workers server socket's events to a sink.
 *
 * `accept()` is called first — a Workers socket cannot send or receive until it
 * is accepted — and the sink's `onOpen` fires immediately afterwards, because
 * Workers emits no `open` event for the server half of a pair.
 *
 * The transport tracks its own state from these events instead of reading the
 * native `readyState`: workerd ties a socket to the request that accepted it,
 * and reading or writing it from another request throws, so a room counting
 * its open members from a route must never touch the native object. The
 * adapter also answers the peer's close frame itself; without
 * `web_socket_auto_reply_to_close` (compatibility date 2026-04-07) workerd
 * leaves that to the Worker, and an unanswered close leaves the client waiting
 * until its own timeout.
 *
 * @param socket - The server half of the pair
 * @param sink - The sink to drive
 * @since 0.2.0
 */
export function bindCloudflareSocketToSink(
  socket: CloudflareServerSocket,
  sink: WebSocketEventSink,
): void {
  socket.accept();
  let state: WebSocketReadyState = 'open';

  socket.addEventListener('message', (event: never): void => {
    const { data } = event as unknown as { data: unknown };
    sink.onMessage(normalizeFrame(data));
  });
  socket.addEventListener('close', (event: never): void => {
    const { code, reason } = event as unknown as { code?: number; reason?: string };
    const received = code ?? 1006;
    if (state === 'open') {
      try {
        socket.close(replyCode(received), reason ?? '');
      } catch {
        // The runtime replied already (web_socket_auto_reply_to_close).
      }
    }
    state = 'closed';
    sink.onClose({ code: received, reason: reason ?? '' });
  });
  socket.addEventListener('error', (event: never): void => {
    state = 'closed';
    sink.onError(toTransportError(event));
  });

  sink.onOpen({
    get readyState(): WebSocketReadyState {
      return state;
    },
    send(data: string | Uint8Array): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      // State moves only once the call returned: a close that throws (an
      // unsendable code, another request's socket) must leave the peer's
      // close still answered.
      socket.close(code, reason);
      if (state === 'open') state = 'closing';
    },
  });
}
