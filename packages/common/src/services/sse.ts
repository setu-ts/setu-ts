/**
 * Server-Sent Events (SSE) contracts — the capability interface the SsePlugin
 * implements under `CAPABILITIES.SSE`.
 *
 * The plugin provides real-time, one-way server-to-client messaging over an
 * HTTP `text/event-stream` connection built on the {@linkcode IResponse.stream}
 * primitive (Milestone 42). A handler opens a connection, the connection stays
 * open after the handler returns (the runtime pumps the stream body lazily),
 * and the connection tears itself down on client disconnect via
 * {@linkcode IRequestContext.signal}.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, IRequestContext } from '../http.ts';
import type { JsonValue } from '../types.ts';

/**
 * A single SSE event payload.
 *
 * @since 0.1.0
 */
export interface SseMessage {
  /** Unique event identifier — sent as `id:` field; enables `Last-Event-ID` resume. */
  readonly id?: string;
  /** Event type name — sent as `event:` field. */
  readonly event?: string;
  /**
   * Event data. A `string` is written literally (split on `\n` into multiple
   * `data:` lines); any non-string is `JSON.stringify`-ed. `undefined` is
   * forbidden — use `{}` or omit the message instead.
   *
   * Typed {@linkcode JsonValue}, so the compiler admits exactly what the
   * encoder can write. A `bigint` makes `JSON.stringify` throw, and a function
   * or symbol value makes it silently drop the key; both are refused here
   * rather than at runtime, where the local delivery path swallows the failure
   * per member and the backplane path throws out of `publish`.
   *
   * A circular structure still throws at runtime — no type can express
   * acyclicity — and a named `interface` does not assign, because TypeScript
   * grants implicit index signatures only to object-literal types. Declare the
   * payload with a `type` alias, or extend `Record<string, JsonValue |
   * undefined>`.
   */
  readonly data: JsonValue;
  /** Reconnection time in milliseconds — sent as `retry:` field. */
  readonly retry?: number;
}

/**
 * A live SSE connection backed by a `ReadableStream`.
 *
 * The connection owns its stream lifecycle (heartbeat interval, controller,
 * abort listener) and exposes `send`, `comment`, and `close`.
 *
 * @since 0.1.0
 */
export interface ISseConnection {
  /** Unique connection ID. */
  readonly id: string;
  /** The client's `Last-Event-ID` header value, if present. */
  readonly lastEventId: string | null;
  /** Whether this connection is still open. */
  readonly isOpen: boolean;
  /**
   * The `HandlerResult` obtained from `ctx.response.stream()`. The handler
   * returns this value so the kernel maps it to the correct web response.
   */
  readonly result: HandlerResult;
  /**
   * Enqueues an encoded SSE frame for the connected client.
   *
   * @param msg - The message to encode and send
   * @throws {Error} If the connection is closed
   */
  send(msg: SseMessage): void;
  /**
   * Enqueues a plain-text comment frame (`: <text>\n\n`) — commonly used as a
   * keep-alive heartbeat.
   *
   * @param text - The comment text
   */
  comment(text: string): void;
  /**
   * Closes the connection: clears the heartbeat, closes the stream controller,
   * and marks the connection as closed. Idempotent.
   */
  close(): void;
}

/**
 * A named broadcast channel within the SSE hub.
 *
 * Multiple connections may subscribe to a channel; publishing a message to the
 * channel delivers it to every open member. Closed members are silently skipped
 * during broadcast.
 *
 * @since 0.1.0
 */
export interface SseChannel {
  /** Number of currently open connections in this channel. */
  readonly size: number;
  /**
   * Adds a connection to this channel's membership.
   *
   * @param conn - The connection to add
   */
  add(conn: ISseConnection): void;
  /**
   * Removes a connection from this channel's membership.
   *
   * @param conn - The connection to remove
   */
  remove(conn: ISseConnection): void;
  /**
   * Publishes a message to every open member of this channel, skipping any
   * connection whose {@linkcode ISseConnection.isOpen} is `false`.
   *
   * @param msg - The message to broadcast
   */
  publish(msg: SseMessage): void;
}

/**
 * Service contract for the SSE hub — registered by the SsePlugin under
 * `CAPABILITIES.SSE`.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
 * const conn = sse.open(ctx);
 * conn.send({ data: 'hello' });
 * ```
 * @since 0.1.0
 */
export interface ISseService {
  /**
   * Opens a new SSE connection for the given request context.
   *
   * Constructs a `ReadableStream`, captures its controller, sets the SSE
   * response headers on the context's response builder, calls
   * `ctx.response.stream(rs)` to obtain the `HandlerResult`, and returns a
   * connection the handler can use to send messages after the handler returns.
   *
   * @param ctx - The current request context
   * @returns The SSE connection with its result
   */
  open(ctx: IRequestContext): ISseConnection;
  /**
   * Returns or creates a named channel.
   *
   * Creating is the point: the first call for a name registers a channel that
   * lives until the process stops. Use {@linkcode ISseService.peek} to read a
   * caller-supplied name without registering anything.
   *
   * @param name - Channel name
   * @returns The named channel
   */
  channel(name: string): SseChannel;
  /**
   * Returns the named channel if one already exists, without creating it.
   *
   * The non-allocating counterpart to {@linkcode ISseService.channel}. A
   * presence or dashboard endpoint that reports `size` for a name taken from a
   * request must use this: `channel(name)` would register one channel per
   * distinct name polled, and an SSE channel is never reclaimed before
   * shutdown.
   *
   * @param name - Channel name
   * @returns The channel, or `undefined` when no channel of that name exists
   * @example
   * ```typescript
   * const subscribers = sse.peek(`build:${id}`)?.size ?? 0;
   * ```
   * @since 0.4.0
   */
  peek(name: string): SseChannel | undefined;
  /** Current number of open connections. */
  readonly connectionCount: number;
  /**
   * Number of channels the registry currently holds.
   *
   * The counterpart to {@linkcode IWebSocketService.roomCount}, and worth
   * watching rather than merely reporting: a channel is created by
   * {@linkcode ISseService.channel} and nothing reclaims it, so **for the life
   * of a running application this number only rises**. A steadily climbing
   * count means channel names are being derived from unbounded input — use
   * {@linkcode ISseService.peek} on any path that reads a caller-supplied name.
   *
   * The one thing that lowers it is shutdown: the plugin's `onClose` discards
   * every channel, so a probe racing teardown reads `0` rather than the last
   * live value.
   *
   * @since 0.4.0
   */
  readonly channelCount: number;
}
