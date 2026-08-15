/**
 * Deno HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * `Deno.serve`.
 *
 * Uses an injectable {@linkcode DenoServeHost} interface that exposes only the
 * Deno-specific operations needed, defaulting to the real `Deno.serve` global
 * via a single boundary cast. This allows unit testing on any runtime by
 * passing a fake host.
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
import { UPGRADE_INTENT } from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';
import { RpcInterceptorStore } from '../shared/rpc-interceptor-store.ts';
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
import { ABNORMAL_CLOSURE } from '../shared/web-socket-transport.ts';
import type { DenoWebSocketUpgrade } from './deno-ws-upgrader.ts';
import { bindDenoSocketToSink } from './deno-ws-upgrader.ts';

// ---------------------------------------------------------------------------
// Host seam
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the Deno operations this adapter needs.
 * Inject this interface to test the adapter without real Deno.
 */
export interface DenoServeHost {
  /**
   * Starts an HTTP server.
   *
   * @param options - Server options
   * @returns The Deno HTTP server
   */
  serve(options: {
    port: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): DenoServer;
  /**
   * Performs an RFC 6455 handshake on an inbound request.
   *
   * Optional so that a host injected before this seam existed still satisfies
   * the interface; when absent, the adapter refuses upgrades with 501.
   *
   * @param request - The native, undisturbed upgrade request
   * @param options - Handshake options; `protocol` echoes a negotiated subprotocol
   * @returns The server-side socket and the 101 response to return
   */
  upgradeWebSocket?(
    request: Request,
    options?: { protocol?: string },
  ): DenoWebSocketUpgrade;
}

/**
 * Deno HTTP server handle (from Deno.serve).
 */
export interface DenoServer {
  /**
   * Shuts down the server.
   */
  shutdown(): Promise<void>;
}

/**
 * Default Deno serve host built from the real `Deno.serve` global.
 * Only evaluated when no host is injected.
 *
 * @internal - Not exported from package index
 */
const defaultDenoServeHost: DenoServeHost = {
  serve: (options) => {
    const server = Deno.serve(
      {
        port: options.port,
        hostname: options.hostname ?? '0.0.0.0',
      },
      options.fetch,
    );
    return server as unknown as DenoServer;
  },
  upgradeWebSocket: (request, options) => {
    const result = options?.protocol !== undefined
      ? Deno.upgradeWebSocket(request, { protocol: options.protocol })
      : Deno.upgradeWebSocket(request);
    return result as unknown as DenoWebSocketUpgrade;
  },
};

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/**
 * Internal handle for a Deno HTTP server.
 *
 * @internal - Not exported from package index
 */
export class DenoHttpServerHandle {
  #handler: ((request: IRequest) => Promise<IResponse>) | null = null;
  #server: DenoServer | null = null;
  readonly #upgrades = new UpgradeRouterStore();
  readonly #rpcStore = new RpcInterceptorStore();
  #host: DenoServeHost;

  constructor(host: DenoServeHost) {
    this.#host = host;
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
   * Stores the gRPC/Connect fetch handler set by `setRpcHandler`.
   */
  setRpcHandler(handler: RpcFetchHandler): void {
    this.#rpcStore.set(handler);
  }

  /**
   * Gets the underlying Deno server (after listen is called).
   */
  get server(): DenoServer | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: DenoServer | null) {
    this.#server = value;
  }

  /**
   * Creates the web-standard fetch handler for Deno.serve.
   *
   * The framework handler (kernel pipeline) runs FIRST on every request.
   * After it returns, the adapter checks for an upgrade intent written by
   * the kernel terminal handler on the IRequest and performs the WebSocket
   * handshake. This ensures middleware (auth, metrics, security headers)
   * applies to upgrade requests uniformly.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }

      // Run the framework handler FIRST — this executes the full middleware
      // pipeline, including auth, metrics, security headers, and shutdown drain.
      const frameworkResponse = await this.#handler(frameworkRequest);

      // After the handler returns, check if the kernel requested an upgrade.
      // The kernel writes WebSocketUpgradeIntent on the IRequest keyed by
      // UPGRADE_INTENT so the adapter can read it here.
      const intent =
        (frameworkRequest as unknown as Record<symbol, WebSocketUpgradeIntent | undefined>)[
          UPGRADE_INTENT
        ];
      if (intent !== undefined) {
        return this.#performUpgrade(request, intent);
      }

      return mapSnapshotToWebResponse(frameworkResponse.snapshot());
    };
  }

  /**
   * Performs the WebSocket handshake using the stored raw Request and the
   * upgrade intent written by the kernel terminal handler.
   */
  #performUpgrade(
    request: Request,
    intent: WebSocketUpgradeIntent,
  ): Response {
    const upgradeWebSocket = this.#host.upgradeWebSocket;
    if (upgradeWebSocket === undefined) {
      intent.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Upgrade unsupported' });
      return new Response(null, { status: 501 });
    }

    try {
      const { socket, response } = upgradeWebSocket.call(
        this.#host,
        request,
        intent.protocol !== undefined ? { protocol: intent.protocol } : undefined,
      );
      bindDenoSocketToSink(socket, intent.sink);
      return response;
    } catch (cause) {
      intent.sink.onClose({
        code: ABNORMAL_CLOSURE,
        reason: cause instanceof Error ? cause.message : 'Handshake failed',
      });
      return new Response(null, { status: 400 });
    }
  }
}

/**
 * Type guard to check if a handle is a DenoHttpServerHandle.
 *
 * @param handle - The handle to check
 * @returns True if the handle is a DenoHttpServerHandle
 */
export function isDenoHttpServerHandle(handle: ServerHandle): handle is DenoHttpServerHandle {
  return handle instanceof DenoHttpServerHandle;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Deno HTTP adapter implementation.
 *
 * @param host - Injected Deno serve host (defaults to real Deno global)
 */
export class DenoHttpAdapter implements IHttpAdapter {
  #host: DenoServeHost;
  #handle: DenoHttpServerHandle;

  constructor(host?: DenoServeHost) {
    this.#host = host ?? defaultDenoServeHost;
    this.#handle = new DenoHttpServerHandle(this.#host);
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

  fetch(request: Request): Promise<Response> {
    return this.#handle.createFetchHandler()(request);
  }

  // deno-lint-ignore require-await
  async listen(port: number, hostname?: string): Promise<ServerHandle> {
    const fetchHandler = this.#handle.createFetchHandler();
    const server = this.#host.serve({
      port,
      ...(hostname !== undefined && { hostname }),
      fetch: fetchHandler,
    });
    this.#handle.server = server;
    return this.#handle;
  }

  async close(handle: ServerHandle): Promise<void> {
    if (!isDenoHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for DenoHttpAdapter');
    }

    if (handle.server !== null) {
      await handle.server.shutdown();
      handle.server = null;
    }
    return Promise.resolve();
  }
}
