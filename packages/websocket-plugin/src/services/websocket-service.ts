/**
 * {@linkcode WebSocketService} — the hub registered under
 * `CAPABILITIES.WEBSOCKET`.
 *
 * It owns the route table, the live connection registry, the rooms, and the
 * heartbeat, and it is the sole author of the {@linkcode WebSocketUpgradeRouter}
 * the HTTP adapter consults. Everything runtime-specific stays in the adapter;
 * this service only ever sees `Request`, {@linkcode IWebSocketTransport}, and
 * frames.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IIngressBehavior,
  ILogger,
  IngressContext,
  IPrincipal,
  IRealtimeBackplane,
  IRuntimeServices,
  IWebSocketConnection,
  IWebSocketService,
  IWebSocketTransport,
  RealtimeFrame,
  WebSocketConnectionContext,
  WebSocketEventSink,
  WebSocketHandlers,
  WebSocketRoom,
  WebSocketRouteOptions,
  WebSocketUpgradeDecision,
  WebSocketUpgradeGuard,
} from '@setu-ts/common';
import {
  composeBehaviorChain,
  decodeFrameData,
  encodeFrameData,
  isWebSocketUpgradeRequest,
} from '@setu-ts/common';
import { WebSocketConnection } from '../connection/websocket-connection.ts';
import { RoomRegistry } from '../rooms/room-registry.ts';
import type { WsRoute } from '../routing/ws-route-table.ts';
import { WsRouteTable } from '../routing/ws-route-table.ts';
import { HeartbeatSweeper } from '../heartbeat/heartbeat.ts';
import { WebSocketUnavailableError } from '../errors/websocket-errors.ts';
import type { WebSocketPluginOptions } from '../interfaces/index.ts';

/** Refused because the server is at its connection limit. */
const STATUS_AT_CAPACITY = 503;
/**
 * Refused because route selection itself threw. Matches the status the
 * adapter-side `UpgradeRouterStore` backstop uses, so a router failure looks
 * the same on the wire wherever it was caught.
 */
const STATUS_ROUTER_FAILED = 500;
/** Close code for a frame that exceeded the configured size limit. */
const CLOSE_MESSAGE_TOO_BIG = 1009;
/** Close code used when the server shuts down. */
const CLOSE_GOING_AWAY = 1001;

/** Resolved options with every default applied. */
interface ResolvedOptions {
  readonly maxConnections: number;
  readonly heartbeatMs: number;
  readonly heartbeatPayload: string;
  readonly idleTimeoutMs: number;
  readonly maxMessageBytes: number;
}

/**
 * Applies defaults and rejects a configuration that cannot work.
 *
 * @param options - The caller's options
 * @returns The resolved options
 * @throws {Error} If an idle timeout is set with no heartbeat to sweep on
 * @since 0.1.0
 */
export function resolveOptions(options?: WebSocketPluginOptions): ResolvedOptions {
  const heartbeatMs = options?.heartbeatMs ?? 0;
  const idleTimeoutMs = options?.idleTimeoutMs ?? 0;

  if (idleTimeoutMs > 0 && heartbeatMs <= 0) {
    throw new Error(
      'WebSocketPlugin: idleTimeoutMs requires heartbeatMs to be greater than 0 — ' +
        'the heartbeat tick is what performs the idle sweep.',
    );
  }

  return {
    maxConnections: options?.maxConnections ?? 0,
    heartbeatMs,
    heartbeatPayload: options?.heartbeatPayload ?? 'ping',
    idleTimeoutMs,
    maxMessageBytes: options?.maxMessageBytes ?? 0,
  };
}

// Hoisted encoder — avoids a per-message allocation on the hot path, matching
// the shared fetch mapping in packages/runtime (AI_GUIDELINES §14).
const encoder = new TextEncoder();

/**
 * Measures an inbound frame in bytes.
 *
 * Text frames are measured by their UTF-8 encoding rather than their string
 * length, so a multi-byte payload is not undercounted against the limit.
 *
 * @param data - The frame
 * @returns The frame size in bytes
 * @since 0.1.0
 */
export function frameByteLength(data: string | Uint8Array): number {
  return typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
}

/**
 * The WebSocket hub.
 *
 * @since 0.1.0
 */
export class WebSocketService implements IWebSocketService {
  readonly #runtime: IRuntimeServices;
  readonly #options: ResolvedOptions;
  readonly #routes = new WsRouteTable();
  readonly #rooms: RoomRegistry;
  readonly #connections = new Set<WebSocketConnection>();
  readonly #heartbeat: HeartbeatSweeper;
  readonly #available: boolean;
  readonly #logger: ILogger | undefined;
  /**
   * Accepted upgrades that have neither opened nor closed yet — sockets still
   * completing their handshake. Counted alongside `#connections` when enforcing
   * `maxConnections`, because `onOpen` fires only after the adapter finishes the
   * handshake and a burst of overlapping handshakes would otherwise all pass the
   * check and blow through the limit.
   */
  #pending = 0;
  /** The cross-replica transport, when one was registered. */
  readonly #backplane: IRealtimeBackplane | undefined;
  /**
   * Whether the backplane transport has been asked to open.
   *
   * Reset on failure so a later upgrade retries rather than leaving the replica
   * permanently deaf — see {@linkcode WebSocketService.#openBackplane}.
   */
  #backplaneOpening = false;
  /**
   * Route-scoped upgrade guards, keyed by the exact route path. Kept beside
   * the route table — whose stored `WsRoute` shape predates guards — and safe
   * to key on path because `WsRouteTable.add` refuses a duplicate path.
   */
  readonly #routeGuards = new Map<string, readonly WebSocketUpgradeGuard[]>();
  /**
   * The plugin-level ingress behaviour chain around `onMessage`. Instances
   * arrive at construction; when factories are configured, the plugin's
   * `onInit` hook replaces this list with the full resolved declared sequence
   * before the application serves. Empty means no chain: dispatch stays the
   * direct, synchronous invoke it has always been.
   */
  readonly #behaviors: IIngressBehavior[];

  /**
   * Creates the service.
   *
   * @param runtime - Runtime services (ids, monotonic clock, timers)
   * @param options - Resolved plugin options
   * @param available - Whether the HTTP adapter can perform upgrades
   * @param logger - Optional logger used to report an upgrade-router failure;
   *   the HTTP adapter that consults the router has no logger of its own
   * @param backplane - Optional cross-replica transport. When present, every
   *   room broadcast is also published to it; when absent, rooms stay purely
   *   in-process, which is the behavior before the backplane existed.
   * @param behaviors - The plugin-level ingress behaviours around `onMessage`,
   *   in declared order. Defaults to none: frame dispatch is then
   *   byte-identical to the pre-chain behaviour.
   */
  constructor(
    runtime: IRuntimeServices,
    options: ResolvedOptions,
    available: boolean,
    logger?: ILogger,
    backplane?: IRealtimeBackplane,
    behaviors?: readonly IIngressBehavior[],
  ) {
    this.#runtime = runtime;
    this.#options = options;
    this.#available = available;
    this.#logger = logger;
    this.#backplane = backplane;
    this.#behaviors = [...(behaviors ?? [])];
    this.#rooms = new RoomRegistry(
      backplane === undefined ? undefined : (name, data, exceptId): void => {
        const payload = encodeFrameData(data);
        // Assembled rather than spread so `exactOptionalPropertyTypes` never
        // sees an explicit `undefined` on an optional field.
        const frame: RealtimeFrame = {
          kind: 'ws-room',
          origin: backplane.origin,
          name,
          data: payload.data,
          ...(payload.binary === true ? { binary: true } : {}),
          ...(exceptId === undefined ? {} : { exceptId }),
        };
        // Fire-and-forget: a transport failure must never make a local
        // broadcast throw for the application that issued it.
        void backplane.publish(frame).catch((error: unknown) => {
          this.#logger?.warn('websocket: backplane publish failed', {
            room: name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      // A local member has just joined, so this replica must be able to
      // RECEIVE — and `subscribe()` alone does not open a transport.
      () => this.#openBackplane(),
    );
    this.#heartbeat = new HeartbeatSweeper(
      runtime,
      {
        heartbeatMs: options.heartbeatMs,
        heartbeatPayload: options.heartbeatPayload,
        idleTimeoutMs: options.idleTimeoutMs,
      },
      () => this.#connections,
    );
  }

  get available(): boolean {
    return this.#available;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  /** Number of registered routes — reported by the health indicator. */
  get routeCount(): number {
    return this.#routes.size;
  }

  route(path: string, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): void {
    if (!this.#available) {
      throw new WebSocketUnavailableError();
    }
    this.#routes.add(path, handlers, options);
    // Guards ride beside the route table — see `#routeGuards`.
    if (options?.guards !== undefined) {
      this.#routeGuards.set(path, options.guards);
    }
    // The first route is what makes the heartbeat worth running.
    this.#heartbeat.start();
  }

  /**
   * Replaces the plugin-level ingress chain around `onMessage` with the
   * resolved declared sequence.
   *
   * Called once by the plugin's `onInit` hook, after every `RegistryFactory`
   * entry of `WebSocketPlugin({ behaviors })` has been resolved — the first
   * phase at which the registry holds every capability, and still before the
   * application serves, so no frame is ever dispatched without the final
   * chain. With no factory behaviours configured it is never called with a
   * non-empty list, and frame dispatch keeps the direct, synchronous form.
   *
   * @param behaviors - The resolved behaviours, in declared order
   * @since 0.3.0
   */
  replaceIngressBehaviors(behaviors: readonly IIngressBehavior[]): void {
    this.#behaviors.splice(0, this.#behaviors.length, ...behaviors);
  }

  /**
   * The upgrade router the kernel terminal handler consults after the
   * middleware pipeline has run without short-circuiting.
   *
   * Delegates to the shared `#routeReported` reporting wrapper: a routing
   * failure is written to the logger here, at its source, before it becomes a
   * refusal. Calling `#route` directly would make this the one entry point
   * whose failures are invisible — the kernel has no logger to write them to.
   *
   * @param request - The native, undisturbed upgrade request
   * @param principal - The authenticated principal, when the middleware
   *   pipeline produced one (`ctx.request.user`). Absent when the upgrade was
   *   not authenticated; treated as an anonymous connection, never a failure.
   * @returns The decision, or `null` when this is not a WebSocket route
   * @since 0.3.0
   */
  routeUpgrade(
    request: Request,
    principal?: IPrincipal,
  ): Promise<WebSocketUpgradeDecision | null> {
    return this.#routeReported(request, principal);
  }

  room(name: string): WebSocketRoom {
    return this.#rooms.get(name);
  }

  /**
   * Returns the named room if one already exists, without creating it.
   *
   * The non-allocating counterpart to {@linkcode WebSocketService.room}. A
   * presence endpoint reading `size` for a request-supplied name must use this:
   * `room()` registers one room per distinct name polled, and a room nobody
   * joined is reclaimed only on the next disconnection.
   *
   * @param name - Room name
   * @returns The room, or `undefined` when no room of that name exists
   * @since 0.4.0
   */
  peek(name: string): WebSocketRoom | undefined {
    return this.#rooms.peek(name);
  }

  /**
   * Delivers a frame that arrived from another replica to this replica's local
   * room members.
   *
   * Called only by the plugin's backplane subscription. It uses the room
   * registry's local-only delivery path, so an arriving frame is never
   * re-published — which would echo it around the cluster forever.
   *
   * Frames of another kind, and frames this instance published itself, are
   * ignored: one backplane topic carries both WebSocket rooms and SSE
   * channels, and a room may legitimately share a name with a channel.
   *
   * @param frame - The arriving frame
   * @since 0.2.0
   */
  deliverRemoteFrame(frame: RealtimeFrame): void {
    if (frame.kind !== 'ws-room' || frame.origin === this.#backplane?.origin) {
      return;
    }
    // A backplane topic is shared infrastructure: a frame can be well-SHAPED
    // (so the transport's guard admits it) while its payload is not valid
    // base64, and `atob` throws on that. Letting it escape would abort the
    // transport's fan-out and starve the SSE consumer subscribed alongside us.
    // The SSE path guards its own `JSON.parse` for the same reason.
    let data: string | Uint8Array;
    try {
      data = decodeFrameData(frame);
    } catch (error) {
      this.#logger?.warn('websocket: dropping an undecodable backplane frame', {
        room: frame.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#rooms.deliverRemote(frame.name, data, frame.exceptId);
  }

  /**
   * The router handed to the HTTP adapter. Matches the request against the
   * route table, applies admission control, and builds the sink the adapter
   * binds its native socket into.
   *
   * Kept at its public single-parameter shape: the adapter consults it with
   * the native request alone and has no principal to thread, so an
   * adapter-side call routes the upgrade as anonymous. A failure is reported
   * through the logger before it is turned into a `500` refusal, via the same
   * `#routeReported` wrapper `routeUpgrade` uses, so the logging behavior has
   * one implementation. The adapter-side `UpgradeRouterStore` also catches,
   * but it runs inside `@setu-ts/runtime`, which has no logger and therefore
   * has nowhere to put the cause — so the only place a routing bug can be made
   * visible is here, at its source.
   *
   * @param request - The native upgrade request
   * @returns The decision, or `null` when this is not a WebSocket route
   * @since 0.1.0
   */
  createUpgradeRouter(): (request: Request) => Promise<WebSocketUpgradeDecision | null> {
    return (request: Request): Promise<WebSocketUpgradeDecision | null> =>
      this.#routeReported(request);
  }

  /**
   * The reporting wrapper both entry points call — the public `routeUpgrade`
   * and the adapter-facing router from `createUpgradeRouter`.
   *
   * A routing failure is written to the logger here, at its source, before it
   * becomes a refusal. The HTTP adapter that consults the router has no logger
   * of its own, and the adapter-side `UpgradeRouterStore` backstop runs inside
   * `@setu-ts/runtime`, which has no logger and therefore has nowhere to put
   * the cause — so this is the one place a routing bug can be made visible.
   *
   * @param request - The native upgrade request
   * @param principal - The authenticated principal, when one authenticated the
   *   upgrade; absent for an anonymous upgrade
   * @returns The decision, or `null` when this is not a WebSocket route
   */
  async #routeReported(
    request: Request,
    principal?: IPrincipal,
  ): Promise<WebSocketUpgradeDecision | null> {
    try {
      return await this.#route(request, principal);
    } catch (error) {
      this.#logger?.error('WebSocket upgrade routing failed', {
        error,
        url: request.url,
      });
      return { accept: false, status: STATUS_ROUTER_FAILED };
    }
  }

  /**
   * The routing decision itself, separated from the reporting wrapper so the
   * happy path stays readable.
   *
   * Async because a route's upgrade guards may be async: the decision is
   * awaited before any admission slot is claimed, so a guard refusal never
   * consumes capacity. With no guards configured the body runs to completion
   * without awaiting, so routing semantics for existing routes are unchanged.
   *
   * @param request - The native upgrade request
   * @param principal - The authenticated principal, when one authenticated the
   *   upgrade; handed to `buildContext` so `onOpen` can read it as
   *   `context.user`
   * @returns The decision, or `null` when this is not a WebSocket route
   */
  async #route(
    request: Request,
    principal?: IPrincipal,
  ): Promise<WebSocketUpgradeDecision | null> {
    // Upgrade detection lives here rather than in the caller. Before M70a the
    // adapter's `UpgradeRouterStore` filtered non-upgrade requests out before
    // consulting, and `WsRouteTable.match` keys on PATH ALONE — so without this
    // an ordinary GET on a WebSocket path would be upgraded. Putting it inside
    // `#route` also puts it inside `createUpgradeRouter`'s reporting wrapper,
    // so a header read that throws is logged rather than escaping into the
    // kernel's generic 500 with nothing written anywhere.
    if (!isWebSocketUpgradeRequest(request.headers)) {
      return null;
    }

    const match = this.#routes.match(request);
    if (match === null) {
      return null;
    }
    if (!match.matched) {
      return { accept: false, status: match.status };
    }

    // Snapshotted here, while the request is still live (the M46 fix), and
    // BEFORE any admission slot is claimed, so a guard refusal or a context
    // failure never consumes capacity. The sink's onOpen fires only after the
    // adapter has answered the handshake, at which point the runtime has
    // already closed the native request and reading its headers throws.
    const context = buildContext(request, match.protocol, principal);

    // Route-scoped upgrade guards, in declared order, before the handshake is
    // accepted. Only the MATCHED route's guards run — a guard registered on
    // one path is invisible to every other path — and the first non-`true`
    // decision refuses with its status. `routeUpgrade` answers through the
    // kernel's refusal shape, which carries a status only; the status is
    // what the client sees.
    const guards = this.#routeGuards.get(match.route.path);
    if (guards !== undefined) {
      for (const guard of guards) {
        const decision = await guard(context);
        if (decision !== true) {
          return { accept: false, status: decision.status };
        }
      }
    }

    // A slot is claimed the moment the upgrade is accepted, not when onOpen
    // fires — see the #pending field.
    if (
      this.#options.maxConnections > 0 &&
      this.#connections.size + this.#pending >= this.#options.maxConnections
    ) {
      return { accept: false, status: STATUS_AT_CAPACITY };
    }
    this.#pending++;

    try {
      const sink = this.#createSink(context, match.route);
      return match.protocol === undefined
        ? { accept: true, sink }
        : { accept: true, sink, protocol: match.protocol };
    } catch (error) {
      // The slot was claimed a moment ago but no sink escaped, so nothing will
      // ever call onOpen/onClose to settle it. Releasing it here is the only
      // thing standing between a routing bug and a server that slowly starves
      // its own maxConnections limit.
      this.#pending--;
      throw error;
    }
  }

  /**
   * Opens the backplane transport, once, on first local use.
   *
   * `IRealtimeBackplane.connect()` is contracted as idempotent, and a
   * subscriber cannot receive anything until it has been called — `subscribe()`
   * only registers a handler. Until this existed the only caller was
   * `RealtimeBackplanePlugin.register()`, so a transport whose provider could
   * not connect at registration (a Cloudflare Durable Object, where
   * `register()` runs at module scope and the platform forbids I/O there) left
   * every listen-only replica silently receiving nothing.
   *
   * Fire-and-forget: an upgrade must not wait on the transport, and a broadcast
   * this replica cannot yet receive is strictly better than a refused
   * connection. The flag is cleared on failure so the next upgrade retries.
   */
  #openBackplane(): void {
    if (this.#backplane === undefined || this.#backplaneOpening) {
      return;
    }
    this.#backplaneOpening = true;
    void this.#backplane.connect().catch((error: unknown) => {
      this.#backplaneOpening = false;
      this.#logger?.warn('websocket: backplane connect failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Closes every connection and stops the heartbeat. Called from the plugin's
   * shutdown hook (AI_GUIDELINES §14.5).
   */
  closeAll(): void {
    this.#heartbeat.stop();
    for (const conn of [...this.#connections]) {
      conn.close(CLOSE_GOING_AWAY, 'Server shutting down');
    }
    this.#connections.clear();
    this.#rooms.clear();
    // In-flight handshakes are abandoned along with everything else.
    this.#pending = 0;
  }

  /**
   * Builds the per-connection sink the adapter drives.
   */
  #createSink(
    context: WebSocketConnectionContext,
    route: WsRoute,
  ): WebSocketEventSink {
    const { handlers } = route;
    let conn: WebSocketConnection | null = null;

    /**
     * Hands an error to the route's `onError`. A reporter that itself fails is
     * swallowed deliberately: there is nowhere left to report it, and letting
     * it escape would break the socket's event dispatch.
     */
    const report = (target: WebSocketConnection, err: unknown): void => {
      if (handlers.onError === undefined) {
        return;
      }
      try {
        const result = handlers.onError(
          target,
          err instanceof Error ? err : new Error(String(err)),
        );
        if (result instanceof Promise) {
          void result.catch(() => {});
        }
      } catch {
        // Deliberately swallowed — the error reporter itself failed.
      }
    };

    /**
     * Invokes a handler, routing a thrown or rejected error to `onError` so a
     * failing callback never becomes an unhandled rejection (§11.7).
     */
    const invoke = <A>(
      handler: ((conn: IWebSocketConnection, arg: A) => void | Promise<void>) | undefined,
      target: WebSocketConnection,
      arg: A,
    ): void => {
      if (handler === undefined) {
        return;
      }
      try {
        const result = handler(target, arg);
        if (result instanceof Promise) {
          void result.catch((err: unknown) => {
            report(target, err);
          });
        }
      } catch (err) {
        report(target, err);
      }
    };

    // The pending slot claimed at accept time is settled exactly once, by
    // whichever of onOpen / onClose arrives first. An adapter whose handshake
    // fails after the router accepted signals it via onClose, so a refused or
    // malformed upgrade can never leak a slot and starve `maxConnections`.
    let settled = false;
    const settlePending = (): void => {
      if (!settled) {
        settled = true;
        this.#pending--;
      }
    };

    return {
      onOpen: (transport: IWebSocketTransport): void => {
        settlePending();
        const opened = new WebSocketConnection(
          this.#runtime.uuid(),
          route.path,
          transport,
          this.#runtime.hrtime(),
          route.heartbeat,
        );
        conn = opened;
        this.#connections.add(opened);
        invoke(handlers.onOpen, opened, context);
      },

      onMessage: (data: string | Uint8Array): void => {
        if (conn === null) {
          return;
        }
        const target = conn;
        target.touch(this.#runtime.hrtime());

        const limit = this.#options.maxMessageBytes;
        if (limit > 0 && frameByteLength(data) > limit) {
          target.close(CLOSE_MESSAGE_TOO_BIG, 'Message too large');
          return;
        }

        if (this.#behaviors.length === 0) {
          // Zero-configuration dispatch — byte-identical to the pre-chain
          // behaviour: a direct, synchronous invoke with no chain allocated.
          invoke(handlers.onMessage, target, data);
          return;
        }

        // The plugin-level behaviour chain. `invoke` stays the outer call, so
        // a rejection — from a behaviour or from the handler — reaches
        // `onError` through the same `report` path as before. The chain
        // returns a promise, while entirely synchronous behaviours and handler
        // preserve their immediate execution; a behaviour that defers `next()`
        // delays the handler. The envelope is built per frame, and the handler
        // keeps its native `(conn, data)` arguments — only the chain sees it.
        const routePath = route.path;
        const behaviors = this.#behaviors;
        invoke(
          (messageConn, frame): Promise<void> =>
            composeBehaviorChain<IngressContext<string | Uint8Array>, void>(
              { kind: 'websocket', name: routePath, payload: frame },
              behaviors,
              () => Promise.resolve(handlers.onMessage?.(messageConn, frame)),
            ),
          target,
          data,
        );
      },

      onClose: (event): void => {
        // Settled first: a handshake that failed before onOpen still has to
        // release its slot, and that path has no connection to report on.
        settlePending();
        if (conn === null) {
          return;
        }
        const closing = conn;
        closing.markClosed();
        this.#connections.delete(closing);
        this.#rooms.evict(closing);
        invoke(handlers.onClose, closing, event);
      },

      onError: (error: Error): void => {
        if (conn === null) {
          return;
        }
        report(conn, error);
      },
    };
  }
}

/**
 * Builds the context handed to `onOpen` from the upgrade request.
 *
 * @param request - The upgrade request
 * @param protocol - The negotiated subprotocol, when one was selected
 * @param principal - The authenticated principal, when one authenticated the
 *   upgrade. When absent the `user` key is omitted entirely rather than set to
 *   `undefined`, keeping the context `exactOptionalPropertyTypes`-clean:
 *   `'user' in context` is `false` for an anonymous connection.
 * @returns The connection context
 * @since 0.1.0
 */
export function buildContext(
  request: Request,
  protocol: string | undefined,
  principal?: IPrincipal,
): WebSocketConnectionContext {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  // Assembled with conditional spreads rather than explicit `undefined`
  // values so `exactOptionalPropertyTypes` is never violated: an anonymous
  // upgrade leaves the `user` key ABSENT (`'user' in context === false`), and
  // a protocol-less one leaves `protocol` absent, exactly as before.
  return {
    url: request.url,
    path: url.pathname,
    query,
    headers: new Headers(request.headers),
    ...(protocol === undefined ? {} : { protocol }),
    ...(principal === undefined ? {} : { user: principal }),
  };
}
