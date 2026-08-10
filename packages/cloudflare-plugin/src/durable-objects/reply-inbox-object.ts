/**
 * The Durable Object side of brokered request-reply: the one addressable place
 * a reply can be delivered to a Worker isolate that is still awaiting it.
 *
 * A Cloudflare queue reaches exactly one consumer Worker, so it cannot carry a
 * reply back to the caller. A Durable Object can: the caller holds a WebSocket
 * to an object named after its own inbox, and the responder — running in a
 * queue-consumer invocation, possibly in a different Worker binding the same
 * namespace — `POST`s the reply to that object, which pushes it down the
 * socket.
 *
 * @module
 * @since 0.2.0
 */

import type { IDurableObjectState, IDurableObjectWebSocket } from './do-facades.ts';
import type { DurableObjectWebSocketHost } from './do-websocket-host.ts';
import { createDefaultDurableObjectWebSocketHost } from './do-websocket-host.ts';

/**
 * Options for {@linkcode ReplyInboxObjectCore}.
 *
 * @since 0.2.0
 */
export interface ReplyInboxObjectCoreOptions {
  /**
   * Supplies the `WebSocketPair` an upgrade needs.
   *
   * Defaults to {@linkcode createDefaultDurableObjectWebSocketHost}, which
   * reads the Workers global — so the default is what runs on every real
   * deployment, and injecting one is what makes the object testable off
   * Workers.
   */
  readonly createPair?: DurableObjectWebSocketHost;
}

/**
 * Delivers RPC replies to the caller waiting on them.
 *
 * **This class holds no state**, for the same reason
 * {@linkcode RealtimeBackplaneObjectCore} holds none: sockets are accepted with
 * `state.acceptWebSocket`, the hibernation API, so the runtime may evict the
 * object and **re-run this constructor** before the reply arrives. A membership
 * `Set` in a field would empty itself on the first hibernation while every
 * test that never hibernates kept passing. `state.getWebSockets()` survives
 * hibernation and is the only membership consulted here.
 *
 * The reply body is forwarded **verbatim** and never parsed, so this object
 * cannot corrupt an envelope and a future widening of the reply shape needs no
 * redeploy of the class the application owns.
 *
 * The application owns the class; this owns the behavior:
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers';
 * import { ReplyInboxObjectCore } from '@setu-ts/cloudflare-plugin';
 *
 * export class ReplyInboxObject extends DurableObject {
 *   #core = new ReplyInboxObjectCore(this.ctx);
 *
 *   override fetch(request: Request): Promise<Response> {
 *     return this.#core.fetch(request);
 *   }
 *   webSocketClose(ws: WebSocket, code: number, reason: string): void {
 *     this.#core.webSocketClose(ws, code, reason);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class ReplyInboxObjectCore {
  readonly #state: IDurableObjectState;
  readonly #host: DurableObjectWebSocketHost;

  /**
   * Builds the core the application's Durable Object class delegates to.
   *
   * @param state - The Durable Object's `ctx`
   * @param options - Optional seams; the defaults are the deployment path
   */
  constructor(state: IDurableObjectState, options: ReplyInboxObjectCoreOptions = {}) {
    this.#state = state;
    this.#host = options.createPair ?? createDefaultDurableObjectWebSocketHost();
  }

  /**
   * Serves both halves of the inbox.
   *
   * A WebSocket upgrade opens the caller's end; a `POST` delivers a reply from
   * a responder. Anything else is refused with the method or upgrade the caller
   * should have used.
   *
   * @param request - The request the stub forwarded
   * @returns A 101 carrying the client half, a 200 reporting how many sockets
   * received the reply, a 405, or a 426
   * @throws {Error} When `WebSocketPair` is unavailable and no host was injected
   * @since 0.2.0
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.#accept();
    }

    if (request.method !== 'POST') {
      return new Response(
        'This Durable Object serves a Setu-TS reply inbox. Open it with a WebSocket upgrade, ' +
          'or deliver a reply with POST.',
        { status: request.method === 'GET' ? 426 : 405 },
      );
    }

    // Read as text and forwarded unparsed: the envelope shape belongs to the
    // broker, not to the object the application deploys.
    const body = await request.text();
    const delivered = this.#broadcast(body);

    // The count is the responder's only signal that the caller was still
    // waiting. Zero is not an error — a caller that timed out has closed its
    // socket, and at-least-once delivery makes a duplicate reply ordinary.
    return new Response(JSON.stringify({ delivered }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Handles the caller disconnecting.
   *
   * Nothing is tracked, so nothing needs removing — the runtime drops the
   * socket from `getWebSockets()` itself. The handler exists so the
   * application's class can forward it without a branch.
   *
   * @param socket - The socket that closed
   * @param code - The close code the peer sent
   * @param reason - The close reason the peer sent
   * @since 0.2.0
   */
  webSocketClose(socket: IDurableObjectWebSocket, code: number, reason: string): void {
    try {
      // 1000 rather than echoing `code`: 1006 is never sendable and would throw.
      socket.close(code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed by the runtime — the common case, and not an error.
      return;
    }
  }

  /**
   * Handles a socket error.
   *
   * @param socket - The socket that errored
   * @since 0.2.0
   */
  webSocketError(socket: IDurableObjectWebSocket): void {
    try {
      socket.close(1011, 'reply inbox socket error');
    } catch {
      return;
    }
  }

  /** Answers an upgrade with the client half of a fresh pair. */
  #accept(): Response {
    const pair = this.#host.createPair();
    // `acceptWebSocket`, never `ws.accept()`: the latter pins the object in
    // memory for the life of the connection, which for an inbox awaiting one
    // reply is billed residency for nothing.
    this.#state.acceptWebSocket(pair.server);

    // The Workers-only `webSocket` member; no other runtime reaches this line.
    const init = { status: 101, webSocket: pair.client } as unknown as ResponseInit;
    return new Response(null, init);
  }

  /** Pushes one reply to every connected caller, returning how many took it. */
  #broadcast(body: string): number {
    let delivered = 0;
    for (const socket of this.#state.getWebSockets()) {
      try {
        socket.send(body);
        delivered += 1;
      } catch {
        // One unwritable peer must not cost the rest their reply. A socket that
        // fails here is already closing; the runtime evicts it from
        // `getWebSockets()` and `webSocketClose` follows.
        continue;
      }
    }
    return delivered;
  }
}
