/**
 * Node HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * `@hono/node-server` (Hono's platform serve layer).
 *
 * Uses an injectable {@linkcode NodeServeHost} interface that exposes
 * `serve({ fetch, port, hostname })` defaulting to a lazy `npm:` import of
 * `@hono/node-server@^2.0.0`. This allows unit testing without a real Node
 * server and prevents global mutation via `overrideGlobalObjects: false`.
 *
 * @module
 */

import type {
  IHttpAdapter,
  IRequest,
  IResponse,
  RpcFetchHandler,
  ServerHandle,
  WebSocketUpgradeIntent,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import { upgradeIntentOf } from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
import { ABNORMAL_CLOSURE } from '../shared/web-socket-transport.ts';
import type { NodeIncomingMessage, RawUpgradeSocket, WsModuleLike } from './node-ws-upgrader.ts';
import {
  asUpgradeEmitter,
  createUpgradeRequest,
  NodeUpgradeCoordinator,
  rejectRawUpgrade,
} from './node-ws-upgrader.ts';

// ---------------------------------------------------------------------------
// Host seam — what the adapter depends on
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the `@hono/node-server` `serve()` operation.
 * Inject this interface to test the adapter without a real Node server.
 */
export interface NodeServeHost {
  /**
   * Starts an HTTP server.
   *
   * @param options - Server options including `fetch`, `port`, `hostname`
   * @returns A promise resolving to a Node.js HTTP server handle
   */
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    port: number;
    hostname?: string;
    overrideGlobalObjects?: boolean;
  }): Promise<NodeServer>;
}

/**
 * Node.js HTTP server handle (returned by `@hono/node-server` `serve()`).
 *
 * `serve()` returns node-server's `ServerType`, which is a `node:http.Server`
 * (or its HTTP/2 equivalents) — so the `upgrade` event this adapter needs for
 * WebSocket support is available on it.
 */
export interface NodeServer {
  /**
   * Stops the server gracefully.
   */
  close(): void;
}

/**
 * Default Node serve host — lazy-loads `@hono/node-server` on first `serve()`
 * call. Throws a clear error if the package is not installed.
 *
 * @internal - Not exported from package index
 */
const defaultNodeServeHost: NodeServeHost = {
  serve: async (options) => {
    // Lazy import — only loads when listen() is actually called
    const mod = await import('npm:@hono/node-server@^2.0.0');
    // overrideGlobalObjects: false prevents @hono/node-server from mutating
    // the global Request/Response which would corrupt the shared mapping.
    return mod.serve({ ...options, overrideGlobalObjects: false });
  },
};

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/**
 * Internal handle for a Node HTTP server.
 *
 * @internal - Not exported from package index
 */
export class NodeHttpServerHandle {
  #handler: ((request: IRequest) => Promise<IResponse>) | null = null;
  #server: NodeServer | null = null;
  readonly #upgrades = new UpgradeRouterStore();
  readonly #coordinator: NodeUpgradeCoordinator;

  constructor(wsModule?: WsModuleLike) {
    this.#coordinator = new NodeUpgradeCoordinator(wsModule);
  }

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handler = handler;
  }

  /**
   * Stores the WebSocket upgrade router set by `setUpgradeRouter`.
   */
  setUpgradeRouter(router: WebSocketUpgradeRouter): void {
    this.#upgrades.set(router);
  }

  /**
   * @deprecated gRPC dispatch now runs through the kernel pipeline.
   * This method is retained for backward compatibility but no longer stores
   * or consults an RPC handler.
   */
  setRpcHandler(_handler: RpcFetchHandler): void {
    // No-op — the handler is no longer used (M70a).
  }

  /**
   * Attaches the raw `upgrade` listener to a freshly-created server.
   *
   * A no-op when no upgrade router was installed (so a plain HTTP app never
   * loads `ws`) or when the server handle emits no events. The listener runs
   * the kernel middleware pipeline before performing the handshake (M70a).
   *
   * @param server - The server returned by `serve()`
   */
  attachUpgradeListener(server: NodeServer): void {
    const emitter = this.#upgrades.hasRouter ? asUpgradeEmitter(server) : null;
    if (emitter === null) {
      return;
    }

    emitter.on('upgrade', (...args: never[]): void => {
      const [incoming, socket, head] = args as unknown as [
        NodeIncomingMessage,
        RawUpgradeSocket,
        unknown,
      ];
      // The listener cannot be async — Node ignores a returned promise — so the
      // rejection is handled here rather than escaping as an unhandled one.
      void this.#handleUpgrade(incoming, socket, head).catch(() => {
        rejectRawUpgrade(socket, 500);
      });
    });
  }

  /**
   * M70a pipeline-first: run the kernel middleware pipeline BEFORE performing
   * the WebSocket handshake, so auth, metrics, and security headers apply
   * uniformly. The socket is raw here (not a fetch path), so we create the
   * web Request, map it to IRequest (threading raw), call the framework
   * handler, then check for UPGRADE_INTENT.
   */
  #handleUpgrade(
    incoming: NodeIncomingMessage,
    socket: RawUpgradeSocket,
    head: unknown,
  ): Promise<void> {
    const request = createUpgradeRequest(incoming);
    const frameworkRequest = mapWebRequestToFrameworkRequest(request);
    return this.#handleUpgradePipeline(incoming, frameworkRequest, socket, head);
  }

  async #handleUpgradePipeline(
    incoming: NodeIncomingMessage,
    frameworkRequestPromise: Promise<IRequest>,
    socket: RawUpgradeSocket,
    head: unknown,
  ): Promise<void> {
    if (!this.#handler) {
      rejectRawUpgrade(socket, 500);
      return;
    }

    const frameworkRequest = await frameworkRequestPromise;
    const frameworkResponse = await this.#handler(frameworkRequest);

    // Check for UPGRADE_INTENT written by the kernel terminal handler on the
    // IRequest.
    const intent = upgradeIntentOf(frameworkRequest);

    if (intent === undefined) {
      // No upgrade intent — the handler returned a normal response (e.g. 401
      // from auth middleware). Reject the raw upgrade with that status.
      rejectRawUpgrade(socket, frameworkResponse.snapshot().status);
      return;
    }

    // Upgrade intent found — perform the handshake.
    try {
      await this.#coordinator.handshake(
        incoming,
        socket,
        head,
        intent.sink,
        intent.protocol,
      );
    } catch (cause) {
      // The kernel already accepted, so release whatever the consumer reserved
      // for this socket before refusing on the wire.
      intent.sink.onClose({
        code: ABNORMAL_CLOSURE,
        reason: cause instanceof Error ? cause.message : 'Handshake failed',
      });
      rejectRawUpgrade(socket, 500);
    }
  }

  /** Shuts down the `ws` server, when one was ever created. */
  closeWebSocketServer(): void {
    this.#coordinator.close();
  }

  /**
   * Gets the underlying Node server (after listen is called).
   */
  get server(): NodeServer | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: NodeServer | null) {
    this.#server = value;
  }

  /**
   * Creates the web-standard fetch handler for @hono/node-server.
   *
   * The framework handler (kernel pipeline) runs FIRST on every request.
   * After it returns, the adapter checks for an upgrade intent written by
   * the kernel terminal handler. WebSocket upgrades on Node arrive via the
   * raw `upgrade` event (not the fetch path), but the upgrade listener also
   * runs the framework handler first before handshaking.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }

      // Run the framework handler FIRST — middleware pipeline applies uniformly.
      const frameworkResponse = await this.#handler(frameworkRequest);

      // Check for upgrade intent (for the rare case an upgrade reaches fetch).
      const intent = upgradeIntentOf(frameworkRequest);
      if (intent !== undefined) {
        return this.#performUpgrade(request, intent);
      }

      return mapSnapshotToWebResponse(frameworkResponse.snapshot());
    };
  }

  /**
   * Performs the WebSocket handshake using the Node ws module.
   */
  #performUpgrade(_request: Request, intent: WebSocketUpgradeIntent): Response {
    // On Node, upgrades normally arrive through the raw `upgrade` event,
    // not the fetch path. If one does reach here, we cannot perform a
    // real handshake (no native socket available), so refuse honestly.
    intent.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Upgrade unsupported on fetch path' });
    return new Response(null, { status: 501 });
  }
}

/**
 * Type guard to check if a handle is a NodeHttpServerHandle.
 *
 * @param handle - The handle to check
 * @returns True if the handle is a NodeHttpServerHandle
 */
export function isNodeHttpServerHandle(handle: ServerHandle): handle is NodeHttpServerHandle {
  return handle instanceof NodeHttpServerHandle;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Node HTTP adapter implementation.
 *
 * @param host - Injected Node serve host (defaults to lazy @hono/node-server)
 */
export class NodeHttpAdapter implements IHttpAdapter {
  #host: NodeServeHost;
  #handle: NodeHttpServerHandle;

  constructor(host?: NodeServeHost, wsModule?: WsModuleLike) {
    this.#host = host ?? defaultNodeServeHost;
    this.#handle = new NodeHttpServerHandle(wsModule);
  }

  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handle.setHandler(handler);
  }

  setUpgradeRouter(router: WebSocketUpgradeRouter): void {
    this.#handle.setUpgradeRouter(router);
  }

  setRpcHandler(handler: RpcFetchHandler): void {
    this.#handle.setRpcHandler(handler);
  }

  async listen(port: number, hostname?: string): Promise<ServerHandle> {
    const fetchHandler = this.#handle.createFetchHandler();
    const server = await this.#host.serve({
      fetch: fetchHandler,
      port,
      ...(hostname !== undefined && { hostname }),
    });
    this.#handle.server = server;
    // WebSocket upgrades never reach the fetch callback on Node — they arrive
    // on the server's raw `upgrade` event, which only exists once serve() has
    // produced a server.
    this.#handle.attachUpgradeListener(server);
    return this.#handle;
  }

  fetch(request: Request): Promise<Response> {
    return this.#handle.createFetchHandler()(request);
  }

  close(handle: ServerHandle): Promise<void> {
    if (!isNodeHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for NodeHttpAdapter');
    }

    handle.closeWebSocketServer();
    if (handle.server !== null) {
      handle.server.close();
      handle.server = null;
    }
    return Promise.resolve();
  }
}
