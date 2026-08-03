/**
 * Structural facades for the Durable Object runtime surface.
 *
 * Written here rather than imported, for the same reason the rest of this
 * package writes its own binding facades: `cloudflare:workers` is unresolvable
 * by Deno, so a static import of `DurableObjectState` would break `deno check`
 * on every other runtime, and a non-literal dynamic import is the fake-lazy
 * -import smell CLAUDE.md bans. Structural typing means the real platform
 * objects satisfy these without any declaration merging, and a plain object
 * satisfies them in a test.
 *
 * Only the members this package actually calls appear. That is interface
 * segregation (AI_GUIDELINES §1.1) rather than laziness — a facade that
 * mirrored the whole platform type would oblige every test double to implement
 * members no code path reads.
 *
 * @module
 * @since 0.2.0
 */

import { CloudflareUnsupportedError } from '../errors.ts';

/**
 * One message arriving on a Durable Object WebSocket.
 *
 * @since 0.2.0
 */
export interface DurableObjectMessageEvent {
  /** The payload, as the runtime delivered it. */
  readonly data: string | ArrayBuffer;
}

/**
 * A WebSocket held by a Durable Object, as the hibernation API hands it back.
 *
 * Deliberately narrower than the client-side socket below: a DO reaches its
 * accepted sockets only through `state.getWebSockets()`, and drives them with
 * `send`/`close`. It never adds listeners, because hibernation delivers
 * incoming messages to the class's `webSocketMessage` handler instead.
 *
 * @since 0.2.0
 */
export interface IDurableObjectWebSocket {
  /**
   * Sends one frame to the peer.
   *
   * @param message - The payload to send
   */
  send(message: string | ArrayBuffer): void;
  /**
   * Closes the connection.
   *
   * @param code - The close code
   * @param reason - The close reason
   */
  close(code?: number, reason?: string): void;
}

/**
 * The client half of a `WebSocketPair`, or the socket a Worker gets back from a
 * Durable Object upgrade.
 *
 * Distinct from {@linkcode IDurableObjectWebSocket} because this side must be
 * `accept()`ed and listened to, while the DO side is accepted by the runtime
 * through `state.acceptWebSocket` and never listened to directly.
 *
 * @since 0.2.0
 */
export interface IDurableObjectClientSocket {
  /**
   * Begins handling the socket in this isolate.
   *
   * Not to be confused with `state.acceptWebSocket`, which is the DO-side
   * hibernation call — see {@linkcode IDurableObjectState.acceptWebSocket}.
   */
  accept(): void;
  /**
   * Sends one frame to the peer.
   *
   * @param message - The payload to send
   */
  send(message: string | ArrayBuffer): void;
  /**
   * Closes the connection.
   *
   * @param code - The close code
   * @param reason - The close reason
   */
  close(code?: number, reason?: string): void;
  /**
   * Subscribes to a socket event.
   *
   * @param type - The event name
   * @param listener - Invoked per event
   */
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: DurableObjectMessageEvent) => void,
  ): void;
}

/**
 * The subset of `DurableObjectStorage` the lock object uses.
 *
 * Persisted rather than in-memory because a Durable Object is evicted after
 * 70–140 seconds of inactivity when it cannot hibernate, and a lock TTL
 * routinely outlives that — a deadline held in a field would evaporate and hand
 * the same lock to a second holder.
 *
 * @since 0.2.0
 */
export interface IDurableObjectStorage {
  /**
   * Reads one persisted value.
   *
   * @param key - The storage key
   * @returns The value, or `undefined` when the key is unset
   */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Writes one value.
   *
   * @param key - The storage key
   * @param value - The value to persist
   */
  put<T>(key: string, value: T): Promise<void>;
  /**
   * Removes one value.
   *
   * @param key - The storage key
   * @returns Whether the key existed
   */
  delete(key: string): Promise<boolean>;
}

/**
 * The `DurableObjectState` (`ctx`) members this package calls.
 *
 * @since 0.2.0
 */
export interface IDurableObjectState {
  /**
   * Accepts a socket as **hibernatable**.
   *
   * Unlike `ws.accept()`, this tells the runtime it need not pin the Durable
   * Object to memory while the connection is open: the object may be evicted
   * and its constructor re-run when the next message arrives. That is why
   * {@linkcode RealtimeBackplaneObjectCore} keeps no membership in a field —
   * {@linkcode getWebSockets} is the only state that survives.
   *
   * @param ws - The server half of the pair
   */
  acceptWebSocket(ws: IDurableObjectWebSocket): void;
  /**
   * Returns every currently connected socket.
   *
   * Survives hibernation, which is what makes it usable as the sole source of
   * truth for broadcast membership.
   *
   * @returns The connected sockets
   */
  getWebSockets(): IDurableObjectWebSocket[];
  /** Durable, transactional key/value storage scoped to this object. */
  readonly storage: IDurableObjectStorage;
}

/**
 * A Durable Object stub's response to a WebSocket upgrade.
 *
 * The platform answers a 101 whose `webSocket` member carries the client half
 * of the connection. That member is Workers-specific and absent from the
 * web-standard `Response`, which is exactly why
 * {@linkcode IServiceBinding.fetch} — whose committed return type is a plain
 * `Response` — cannot express an upgrade on its own.
 *
 * @since 0.2.0
 */
export interface DurableObjectUpgradeResponse {
  /** Always `101 Switching Protocols` on a successful upgrade. */
  readonly status: number;
  /** The client half of the connection. */
  readonly webSocket: IDurableObjectClientSocket;
}

/** The Workers-only `webSocket` member, as it appears on a real response. */
interface MaybeUpgradeResponse {
  readonly status: number;
  readonly webSocket?: unknown;
}

/**
 * Narrows a Durable Object stub's response to one carrying a socket.
 *
 * A stub answering an ordinary `Response` — a 404 from a DO class with no
 * upgrade path, a 500 from one that threw, a 101 from a runtime that does not
 * populate `webSocket` — fails here, naming the binding, rather than surfacing
 * later as a `TypeError` on `undefined.accept()` with nothing to point at.
 *
 * @param response - The stub's response
 * @param binding - The Durable Object binding name, for the error message
 * @returns The same response, narrowed
 * @throws {CloudflareUnsupportedError} When the response carries no `webSocket`
 * @example
 * ```typescript
 * const response = await stub.fetch('https://do/connect', {
 *   headers: { Upgrade: 'websocket' },
 * });
 * const socket = asUpgradeResponse(response, 'REALTIME').webSocket;
 * socket.accept();
 * ```
 * @since 0.2.0
 */
export function asUpgradeResponse(
  response: unknown,
  binding: string,
): DurableObjectUpgradeResponse {
  const candidate = response as MaybeUpgradeResponse | null | undefined;
  const socket = candidate?.webSocket;
  if (socket === null || socket === undefined) {
    throw new CloudflareUnsupportedError(
      `Durable Object binding '${binding}' answered a WebSocket upgrade with status ` +
        `${candidate?.status ?? 'unknown'} and no 'webSocket' member. The Durable Object ` +
        `class must answer an upgrade request with a 101 carrying the client half of a ` +
        `WebSocketPair — see RealtimeBackplaneObjectCore.`,
    );
  }
  return { status: candidate?.status ?? 101, webSocket: socket as IDurableObjectClientSocket };
}
