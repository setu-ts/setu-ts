/**
 * The replica side of the Durable Object realtime backplane.
 *
 * @module
 * @since 0.2.0
 */

import type {
  ILogger,
  IRealtimeConnectionLink,
  IRealtimeHandlerErrorReporter,
  IRealtimeLinkBackplane,
  IRuntimeServices,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@setu-ts/common';
import { createRealtimeHandlerErrorReporter, dispatchRealtimeFrame } from '@setu-ts/common';

import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import type {
  DurableObjectMessageEvent,
  IDurableObjectClientSocket,
} from '../durable-objects/do-facades.ts';
import { asUpgradeResponse } from '../durable-objects/do-facades.ts';
import { isRealtimeFrame } from '../durable-objects/frame-guard.ts';
import { ConnectionLink } from './connection-link.ts';

/** The synthetic URL the stub is fetched with. Only the path is meaningful. */
const CONNECT_URL = 'https://realtime-backplane.internal/connect';

/** The synthetic URL a frame is POSTed to for fan-out without a socket. */
const PUBLISH_URL = 'https://realtime-backplane.internal/publish';

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
  /**
   * Receives every subscriber throw or rejection instead of default logging.
   * Hook failures are swallowed.
   * @since 0.11.0
   */
  readonly onHandlerError?: (error: unknown, frame: RealtimeFrame) => void;
  /**
   * Keeps a {@linkcode DurableObjectBackplane.publishViaHub} POST alive after
   * the response it was issued from has been sent. Absent, the POST is awaited
   * by its caller's promise only.
   * @since 0.14.0
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Timers for a connection link's reopen delays. Required to open links.
   * @since 0.14.0
   */
  readonly timers?: Pick<IRuntimeServices, 'setTimeout' | 'clearTimeout'>;
}

/**
 * Carries {@linkcode RealtimeFrame}s between replicas through one Durable
 * Object per topic (the hub).
 *
 * Two paths, because workerd ties every I/O object to the request that
 * created it and touching it from another request throws:
 *
 * - **Per-connection links** ({@linkcode DurableObjectBackplane.openConnectionLink},
 *   {@linkcode DurableObjectBackplane.publishViaHub}) are what WebSocket rooms
 *   use on Workers. Each client connection opens its own link from its own
 *   request, so every frame for it is delivered in the request that owns its
 *   socket; a broadcast from any other request is POSTed to the hub, which
 *   needs no socket. Client sockets are request-bound, never isolate-wide, so
 *   a room cannot write to all its members from one request.
 * - **The isolate socket** (`connect`/`publish`/`subscribe`) carries frames
 *   for consumers that still hold one isolate-level subscription
 *   (`sse-plugin`, and any runtime other than Workers). It is opened lazily
 *   on the first publish, retired and closed when it fails, and a publish
 *   that finds it dead reopens once and resends the same frame.
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
export class DurableObjectBackplane implements IRealtimeLinkBackplane {
  readonly origin: string;
  readonly #namespace: IDurableObjectNamespace;
  readonly #options: DurableObjectBackplaneOptions;
  readonly #handlers = new Set<RealtimeFrameHandler>();
  readonly #handlerReporter: IRealtimeHandlerErrorReporter;

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
    this.#handlerReporter = createRealtimeHandlerErrorReporter({
      source: 'cloudflare: backplane',
      logger: () => options.logger?.(),
      ...(options.onHandlerError === undefined ? {} : { onHandlerError: options.onHandlerError }),
    });
  }

  /**
   * Opens the socket to the Durable Object. Idempotent and concurrency-safe.
   *
   * @throws {CloudflareUnsupportedError} When the object answers an upgrade
   * with no `webSocket` member
   */
  async connect(): Promise<void> {
    const attempt = (this.#opening ??= this.#open());
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
      return;
    } catch {
      // The socket is dead (or, on Workers, belongs to a request that has
      // ended): retire it, reopen once and send the same frame again, so the
      // frame that discovered the dead socket is not the one lost.
      this.#retire(socket);
    }
    try {
      await this.connect();
      this.#socket?.send(JSON.stringify(frame));
    } catch (error) {
      // Reported rather than rethrown: both consuming plugins call publish
      // detached (`void backplane.publish(f).catch(...)`), so an unreported
      // throw here is invisible.
      if (this.#socket !== undefined) this.#retire(this.#socket);
      this.#options.logger?.()?.warn('cloudflare: backplane publish failed', {
        topic: this.#options.topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Opens one connection's own link to the hub, from the request that owns
   * the connection.
   * @param connectionId - The connection's id, for log lines
   * @param deliver - Receives every frame the hub sends the link
   * @returns The link
   * @throws {Error} When the backplane was built without `timers`
   * @since 0.14.0
   */
  openConnectionLink(
    connectionId: string,
    deliver: (frame: RealtimeFrame) => void,
  ): IRealtimeConnectionLink {
    const timers = this.#options.timers;
    if (timers === undefined) {
      throw new Error('DurableObjectBackplane: openConnectionLink needs the timers option');
    }
    return new ConnectionLink({
      hub: () => this.#namespace.get(this.#namespace.idFromName(this.#options.topic)),
      binding: this.#options.binding,
      topic: this.#options.topic,
      connectionId,
      deliver,
      timers,
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      ...(this.#options.waitUntil === undefined ? {} : { waitUntil: this.#options.waitUntil }),
    });
  }

  /**
   * Publishes a frame to every link and socket through the hub with an HTTP
   * POST, which needs no socket and so works from any request. Handed to
   * `waitUntil` when one was given, so a route that answers first does not cut
   * it off. A failure is logged, never thrown.
   * @param frame - The frame to publish
   * @returns Resolves once the hub answered (or the POST failed)
   * @since 0.14.0
   */
  publishViaHub(frame: RealtimeFrame): Promise<void> {
    const posted = this.#post(frame);
    this.#options.waitUntil?.(posted);
    return posted;
  }

  /** The POST itself, with its failure reported. */
  async #post(frame: RealtimeFrame): Promise<void> {
    try {
      const stub = this.#namespace.get(this.#namespace.idFromName(this.#options.topic));
      const response = await stub.fetch(PUBLISH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(frame),
      });
      if (!response.ok) {
        this.#options.logger?.()?.warn('cloudflare: backplane publish failed', {
          topic: this.#options.topic,
          status: response.status,
        });
      }
    } catch (error) {
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
    // Closed, not only dropped: an unreferenced socket stays open at the hub,
    // which keeps fanning every frame out to it.
    this.#closeQuietly(socket);
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
    dispatchRealtimeFrame(this.#handlers, parsed, this.#handlerReporter);
  }
}
