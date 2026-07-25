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

import type { WebSocketEventSink } from '@hono-enterprise/common';
import type { WebSocketLike } from '../shared/web-socket-transport.ts';
import {
  createWebSocketTransport,
  normalizeFrame,
  toTransportError,
} from '../shared/web-socket-transport.ts';

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
 * Binds a Workers server socket's events to a sink.
 *
 * `accept()` is called first — a Workers socket cannot send or receive until it
 * is accepted — and the sink's `onOpen` fires immediately afterwards, because
 * Workers emits no `open` event for the server half of a pair.
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

  socket.addEventListener('message', (event: never): void => {
    const { data } = event as unknown as { data: unknown };
    sink.onMessage(normalizeFrame(data));
  });
  socket.addEventListener('close', (event: never): void => {
    const { code, reason } = event as unknown as { code?: number; reason?: string };
    sink.onClose({ code: code ?? 1006, reason: reason ?? '' });
  });
  socket.addEventListener('error', (event: never): void => {
    sink.onError(toTransportError(event));
  });

  sink.onOpen(createWebSocketTransport(socket));
}
