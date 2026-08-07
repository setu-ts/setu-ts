/**
 * The replica side of the Durable Object realtime backplane.
 *
 * @module
 * @since 0.2.0
 */

import type {
  ILogger,
  IRealtimeBackplane,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@setu-ts/common';

import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import type {
  DurableObjectMessageEvent,
  IDurableObjectClientSocket,
} from '../durable-objects/do-facades.ts';
import { asUpgradeResponse } from '../durable-objects/do-facades.ts';
import { dispatchFrame, isRealtimeFrame } from '../durable-objects/frame-dispatch.ts';

/** The synthetic URL the stub is fetched with. Only the path is meaningful. */
const CONNECT_URL = 'https://realtime-backplane.internal/connect';

/**
 * Options for {@linkcode DurableObjectBackplane}.
 *
 * @since 0.2.0
 */
export interface DurableObjectBackplaneOptions {
  /**
   * This instance's identity, stamped on every published frame.
   *
   * Must be unique per replica; `runtime.uuid()` is what the plugin passes.
   */
  readonly origin: string;
  /**
   * The Durable Object binding name, used only in error messages.
   */
  readonly binding: string;
  /**
   * The object name every replica shares, from `idFromName`.
   *
   * Two applications sharing one namespace must use different topics, or each
   * receives the other's frames.
   */
  readonly topic: string;
  /**
   * Logger accessor for reporting a transport failure.
   *
   * A **thunk**, never a captured value: the kernel answers `ctx.logger` as
   * `undefined` until a logger is registered, and a logger may be registered
   * imperatively after this plugin's `register()` runs. Capturing the value
   * would silence every report for that application.
   */
  readonly logger?: () => ILogger | undefined;
}

/**
 * Carries {@linkcode RealtimeFrame}s between replicas over one WebSocket to a
 * Durable Object.
 *
 * **The guarantee is narrower than "a durable cross-replica subscription", and
 * deliberately so.** A Cloudflare Worker isolate is evicted at the platform's
 * discretion and its outbound WebSockets go with it, so no Worker can hold a
 * subscription indefinitely. What makes that sound rather than lossy is the
 * coupling: the members this subscription serves are client WebSockets held by
 * the *same* isolate, and an HTTP-triggered Worker stays alive as long as its
 * clients remain connected. Losing the isolate loses the subscription and the
 * members it was fanning out to **together**, which is consistent. The socket
 * is therefore opened lazily on the first publish and reopened after any
 * failure, rather than held open by a keepalive that would only fight the
 * platform's eviction.
 *
 * @example
 * ```typescript
 * app.register(CloudflarePlugin({
 *   env,
 *   waitUntil,
 *   durableObject: { binding: 'REALTIME', topic: 'chat' },
 * }));
 * // websocket-plugin and sse-plugin resolve it themselves; nothing else to wire.
 * ```
 * @since 0.2.0
 */
export class DurableObjectBackplane implements IRealtimeBackplane {
  readonly origin: string;
  readonly #namespace: IDurableObjectNamespace;
  readonly #options: DurableObjectBackplaneOptions;
  readonly #handlers = new Set<RealtimeFrameHandler>();

  #socket: IDurableObjectClientSocket | undefined;
  /**
   * The in-flight (or settled) open, so overlapping calls join one attempt
   * instead of each opening its own socket. Cleared on failure, on close, and
   * whenever the socket drops, so the next publish genuinely reopens.
   */
  #opening: Promise<void> | undefined;
  /**
   * Bumped by `close()`. An attempt captures this on entry and compares before
   * publishing its socket, so a close landing mid-attempt retires the socket
   * rather than letting it arrive on a closed backplane with nothing holding a
   * reference to shut it down.
   */
  #generation = 0;

  /**
   * @param namespace - The Durable Object namespace binding
   * @param options - Identity, topic, and the logger thunk
   */
  constructor(namespace: IDurableObjectNamespace, options: DurableObjectBackplaneOptions) {
    this.#namespace = namespace;
    this.#options = options;
    this.origin = options.origin;
  }

  /**
   * Opens the socket to the Durable Object. Idempotent and concurrency-safe.
   *
   * @throws {CloudflareUnsupportedError} When the object answers an upgrade
   * with no `webSocket` member
   */
  async connect(): Promise<void> {
    const attempt = this.#opening ??= this.#open();
    try {
      await attempt;
    } catch (error) {
      // Only retract the attempt this call awaited; clearing unconditionally
      // would let a late waiter on an old failure wipe a newer attempt's memo.
      if (this.#opening === attempt) {
        this.#opening = undefined;
      }
      throw error;
    }
  }

  /**
   * Performs one open attempt, publishing the socket only once it is live.
   *
   * @throws {CloudflareUnsupportedError} When the upgrade carries no socket
   */
  async #open(): Promise<void> {
    const generation = this.#generation;
    const stub = this.#namespace.get(this.#namespace.idFromName(this.#options.topic));
    const response = await stub.fetch(CONNECT_URL, {
      headers: { Upgrade: 'websocket' },
    });
    const socket = asUpgradeResponse(response, this.#options.binding).webSocket;
    socket.accept();

    if (generation !== this.#generation) {
      // A close() landed mid-attempt. Publishing now would hand a live socket
      // to a closed backplane, where nothing holds a reference to shut it down.
      this.#closeQuietly(socket);
      return;
    }

    socket.addEventListener('message', (event) => {
      this.#receive(event);
    });
    // A dropped socket must not leave the memo pointing at a resolved attempt,
    // or every later publish would write into a dead connection in silence.
    socket.addEventListener('close', () => {
      this.#retire(socket);
    });
    socket.addEventListener('error', () => {
      this.#retire(socket);
    });

    this.#socket = socket;
  }

  /**
   * Publishes a frame to every other subscribed replica.
   *
   * @param frame - The frame to publish
   * @throws {CloudflareUnsupportedError} When the socket cannot be opened
   */
  async publish(frame: RealtimeFrame): Promise<void> {
    await this.connect();
    const socket = this.#socket;
    if (socket === undefined) {
      // Only reachable when a close() raced this publish, in which case there
      // is deliberately nothing to send.
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      // Reported rather than rethrown: both consuming plugins call publish
      // detached (`void backplane.publish(f).catch(...)`), so an unreported
      // throw here is invisible. Retiring the socket is what turns a dead
      // connection into a reconnect instead of a permanently silent backplane.
      this.#retire(socket);
      this.#options.logger?.()?.warn('cloudflare: backplane publish failed', {
        topic: this.#options.topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Registers a handler for frames arriving from other replicas.
   *
   * @param handler - Invoked per arriving frame
   * @returns A function that removes this handler
   */
  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  /**
   * Closes the socket and drops every handler.
   */
  close(): Promise<void> {
    // Invalidate any open still in flight before reading the field below: it
    // has not published its socket yet, so this is what tells it to retire.
    this.#generation++;
    this.#handlers.clear();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#opening = undefined;
    if (socket !== undefined) {
      this.#closeQuietly(socket);
    }
    return Promise.resolve();
  }

  /**
   * Drops a socket that is no longer usable, so the next publish reopens.
   *
   * Guarded on identity: a late `close` event from an already-replaced socket
   * must not retire the live one.
   *
   * @param socket - The socket reporting itself dead
   */
  #retire(socket: IDurableObjectClientSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#opening = undefined;
  }

  /**
   * Closes a socket without letting a failure escape.
   *
   * @param socket - The socket to close
   */
  #closeQuietly(socket: IDurableObjectClientSocket): void {
    try {
      socket.close(1000, 'backplane closed');
    } catch {
      // Already closed, or closing — either way there is no caller to inform
      // and nothing left to clean up.
      return;
    }
  }

  /**
   * Parses one arriving message and hands it to the handlers.
   *
   * A Durable Object namespace is shared infrastructure, so unparseable or
   * foreign traffic is dropped rather than allowed to throw inside a socket
   * event listener, where nothing would catch it.
   *
   * @param event - The socket message event
   */
  #receive(event: DurableObjectMessageEvent): void {
    if (typeof event.data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    // The own-origin check is belt and braces beside the object's sender
    // exclusion: the reconnect path in this class makes it briefly possible for
    // one replica to hold two sockets to the same object, and without this the
    // second would deliver this replica's own broadcasts back to it.
    if (!isRealtimeFrame(parsed) || parsed.origin === this.origin) {
      return;
    }
    dispatchFrame(this.#handlers, parsed, (error) => {
      this.#options.logger?.()?.warn('cloudflare: backplane subscriber threw', {
        topic: this.#options.topic,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
