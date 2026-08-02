/**
 * The Durable Object side of the realtime backplane: the fan-out hub every
 * replica connects to.
 *
 * @module
 * @since 0.2.0
 */

import type { IDurableObjectState, IDurableObjectWebSocket } from './do-facades.ts';
import type { DurableObjectWebSocketHost } from './do-websocket-host.ts';
import { createDefaultDurableObjectWebSocketHost } from './do-websocket-host.ts';

/**
 * Options for {@linkcode RealtimeBackplaneObjectCore}.
 *
 * @since 0.2.0
 */
export interface RealtimeBackplaneObjectCoreOptions {
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
 * Fans one replica's broadcast out to every other connected replica.
 *
 * **This class holds no state.** Not as a simplification — as a correctness
 * requirement. Sockets are accepted with `state.acceptWebSocket`, the
 * hibernation API, which lets the Workers runtime evict the Durable Object from
 * memory while its connections stay open and **re-run the constructor** when
 * the next message arrives. A membership `Set` held in a field would therefore
 * empty itself on the first hibernation, and every test that never hibernates
 * would still pass. `state.getWebSockets()` survives hibernation and is the
 * only source of truth used here.
 *
 * The payload is re-broadcast **verbatim**, never parsed. That costs no CPU per
 * fan-out, makes it impossible for this object to corrupt a frame, and — since
 * a Durable Object class is deployed by the *application* rather than by this
 * package — means a future widening of `RealtimeFrame` needs no redeploy of the
 * object to carry the new field.
 *
 * The application owns the class; this owns the behavior:
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers';
 * import { RealtimeBackplaneObjectCore } from '@hono-enterprise/cloudflare-plugin';
 *
 * export class RealtimeBackplaneObject extends DurableObject {
 *   #core = new RealtimeBackplaneObjectCore(this.ctx);
 *
 *   override fetch(request: Request): Promise<Response> {
 *     return this.#core.fetch(request);
 *   }
 *   webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
 *     this.#core.webSocketMessage(ws, message);
 *   }
 *   webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
 *     this.#core.webSocketClose(ws, code, reason, wasClean);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class RealtimeBackplaneObjectCore {
  readonly #state: IDurableObjectState;
  readonly #host: DurableObjectWebSocketHost;

  /**
   * @param state - The Durable Object's `ctx`
   * @param options - Optional seams; the defaults are the deployment path
   */
  constructor(state: IDurableObjectState, options: RealtimeBackplaneObjectCoreOptions = {}) {
    this.#state = state;
    this.#host = options.createPair ?? createDefaultDurableObjectWebSocketHost();
  }

  /**
   * Answers a replica's WebSocket upgrade.
   *
   * @param request - The request the stub forwarded
   * @returns A 101 carrying the client half, or a 426 for a non-upgrade request
   * @throws {Error} When `WebSocketPair` is unavailable and no host was injected
   */
  fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Promise.resolve(
        new Response(
          'This Durable Object serves the Hono Enterprise realtime backplane and accepts ' +
            'only WebSocket upgrades.',
          { status: 426 },
        ),
      );
    }

    const pair = this.#host.createPair();
    // `acceptWebSocket`, never `ws.accept()`: the latter pins this object in
    // memory for the life of every connection, which for an idle room is a
    // permanent billed residency.
    this.#state.acceptWebSocket(pair.server);

    // The Workers-only `webSocket` member; other runtimes drop it, and no other
    // runtime reaches this line.
    const init = { status: 101, webSocket: pair.client } as unknown as ResponseInit;
    return Promise.resolve(new Response(null, init));
  }

  /**
   * Re-broadcasts one replica's message to every other connected replica.
   *
   * @param sender - The socket the message arrived on
   * @param message - The payload, forwarded byte for byte
   */
  webSocketMessage(sender: IDurableObjectWebSocket, message: string | ArrayBuffer): void {
    for (const socket of this.#state.getWebSockets()) {
      // Excluding the sender is what implements the contract's rule that a
      // publish is not delivered back to the publishing instance's handlers.
      if (socket === sender) continue;
      try {
        socket.send(message);
      } catch {
        // One unwritable peer must never cost the rest their message. A socket
        // that fails here is already closing; the runtime evicts it from
        // `getWebSockets()` and `webSocketClose` follows, so there is nothing
        // to clean up and no caller to report to.
        continue;
      }
    }
  }

  /**
   * Handles a replica disconnecting.
   *
   * Nothing is tracked, so nothing needs removing — the runtime drops the
   * socket from `getWebSockets()` on its own. The handler exists so the
   * application's class can forward it without a branch, and so the close is
   * acknowledged rather than left to the runtime's default.
   *
   * @param socket - The socket that closed
   * @param code - The close code the peer sent
   * @param reason - The close reason the peer sent
   */
  webSocketClose(socket: IDurableObjectWebSocket, code: number, reason: string): void {
    try {
      // 1000 rather than echoing `code`: a peer may close with a reserved code
      // (1006 is never sendable), which would throw here.
      socket.close(code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed by the runtime — the common case, and not an error.
      return;
    }
  }

  /**
   * Handles a socket error.
   *
   * The runtime closes the socket itself, so this only prevents an unhandled
   * rejection inside the application's class.
   *
   * @param socket - The socket that errored
   */
  webSocketError(socket: IDurableObjectWebSocket): void {
    try {
      socket.close(1011, 'backplane socket error');
    } catch {
      return;
    }
  }
}
