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
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
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
   * The WebSocket upgrade is consulted first and short-circuits: the request
   * body must stay undisturbed for `Deno.upgradeWebSocket` to succeed. Then the
   * RPC interceptor is consulted exactly once; a returned Response
   * short-circuits as RPC, while null falls through. Only then is the body
   * mapped via `mapWebRequestToFrameworkRequest`, which reads it.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const upgraded = await this.#tryUpgrade(request);
      if (upgraded !== null) {
        return upgraded;
      }

      const rpcResult = await this.#rpcStore.consult(request);
      if (rpcResult !== null) {
        return rpcResult;
      }

      const frameworkRequest = await mapWebRequestToFrameworkRequest(request);
      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }
      const frameworkResponse = await this.#handler(frameworkRequest);
      return mapSnapshotToWebResponse(frameworkResponse.snapshot());
    };
  }

  /**
   * Performs the handshake when the router accepts. Returns `null` to fall
   * through to normal HTTP handling.
   */
  async #tryUpgrade(request: Request): Promise<Response | null> {
    const decision = await this.#upgrades.consult(request);
    if (decision === null) {
      return null;
    }
    if (!decision.accept) {
      return new Response(null, { status: decision.status });
    }

    const upgradeWebSocket = this.#host.upgradeWebSocket;
    if (upgradeWebSocket === undefined) {
      // A host injected before this seam existed cannot handshake. Refusing is
      // the honest answer; falling through would hand a WebSocket client an
      // ordinary HTTP response it cannot interpret.
      decision.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Upgrade unsupported' });
      return new Response(null, { status: 501 });
    }

    try {
      const { socket, response } = upgradeWebSocket.call(
        this.#host,
        request,
        decision.protocol !== undefined ? { protocol: decision.protocol } : undefined,
      );
      bindDenoSocketToSink(socket, decision.sink);
      return response;
    } catch (cause) {
      // The router already accepted, so the consumer may be holding resources
      // for this socket (a reserved connection slot). Tell it the connection is
      // over rather than leaving the sink dangling forever.
      decision.sink.onClose({
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
