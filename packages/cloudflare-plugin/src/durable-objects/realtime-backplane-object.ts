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
 * The largest frame `POST /publish` accepts: workerd's ceiling for one
 * received WebSocket message (32 MiB), so nothing the hub forwards can exceed
 * what a link may receive.
 */
const MAX_FRAME_BYTES = 33_554_432;

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
 * import { RealtimeBackplaneObjectCore } from '@setu-ts/cloudflare-plugin';
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
   * Answers a replica's WebSocket upgrade, or a `POST /publish`.
   *
   * @param request - The request the stub forwarded
   * @returns A 101 carrying the client half, or a 426 for a non-upgrade
   *   request; for `POST /publish`, 204, 413 above 33,554,432 bytes, or 400 for
   *   a body that is not valid UTF-8
   * @throws {Error} When `WebSocketPair` is unavailable and no host was injected
   */
  fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/publish') {
      return this.#publish(request);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Promise.resolve(
        new Response(
          'This Durable Object serves the Setu-TS realtime backplane and accepts ' +
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
   * Fans one POSTed frame out to every connected socket, the publisher's own
   * link included (a POST has no socket to exclude). The body is forwarded
   * verbatim, never parsed; the receiving side validates it.
   * @param request - The POST carrying one serialized frame
   * @returns 204; 413 above the platform's received-message ceiling; 400 for
   *   a body that is not valid UTF-8 (decoding it would replace every bad
   *   byte with U+FFFD, up to three times its size on the hub's sockets)
   */
  async #publish(request: Request): Promise<Response> {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_FRAME_BYTES) return new Response(null, { status: 413 });
    const body = await readBounded(request, MAX_FRAME_BYTES);
    if (body === TOO_LARGE) return new Response(null, { status: 413 });
    if (body === NOT_UTF8) return new Response(null, { status: 400 });
    for (const socket of this.#state.getWebSockets()) {
      try {
        socket.send(body);
      } catch {
        // One unwritable peer must never cost the rest their frame.
        continue;
      }
    }
    return new Response(null, { status: 204 });
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

/** {@linkcode readBounded}'s answer for a body larger than its limit. */
const TOO_LARGE: unique symbol = Symbol('too large');
/** {@linkcode readBounded}'s answer for a body that is not valid UTF-8. */
const NOT_UTF8: unique symbol = Symbol('not utf-8');

/**
 * Reads a request body as text, stopping as soon as it passes `limit` bytes
 * (a body without `Content-Length` is otherwise read whole first). The decode
 * is strict: a lenient one would turn each invalid byte into a three-byte
 * U+FFFD and send the hub's sockets a frame larger than the limit.
 *
 * @returns The text, {@linkcode TOO_LARGE} once the body is larger than
 *   `limit`, or {@linkcode NOT_UTF8} when it does not decode
 */
async function readBounded(
  request: Request,
  limit: number,
): Promise<string | typeof TOO_LARGE | typeof NOT_UTF8> {
  const stream = request.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // The body is refused either way.
      }
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return NOT_UTF8;
  }
}
