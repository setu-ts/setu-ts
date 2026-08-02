/**
 * Bun HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * Bun's `Bun.serve` API.
 *
 * Uses an injectable {@linkcode BunServeHost} interface that exposes only the
 * Bun-specific operations needed, defaulting to the real `Bun` global via a
 * single boundary cast. This allows unit testing on any runtime by passing
 * a fake host.
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
} from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';
import { RpcInterceptorStore } from '../shared/rpc-interceptor-store.ts';
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
import { ABNORMAL_CLOSURE } from '../shared/web-socket-transport.ts';
import type { BunSocketData, BunWebSocketHandlers } from './bun-ws-upgrader.ts';
import { createBunWebSocketHandlers } from './bun-ws-upgrader.ts';

// ---------------------------------------------------------------------------
// Host seam (existing)
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the Bun-specific HTTP operations used by this adapter.
 * Inject this interface to test the adapter without real Bun.
 */
export interface BunServeHost {
  /**
   * Starts an HTTP server.
   *
   * The `fetch` callback receives the `BunServer` as its second argument
   * (Bun's own signature) because `server.upgrade()` is the only way to
   * perform a WebSocket handshake, and it may resolve `undefined` to tell Bun
   * that the request was upgraded and needs no response.
   *
   * @param options - Server options
   * @returns The server handle
   */
  serve(options: {
    port: number;
    hostname?: string;
    fetch: (
      request: Request,
      server: BunServer,
    ) => Response | undefined | Promise<Response | undefined>;
    websocket?: BunWebSocketHandlers;
  }): BunServer;
}

/**
 * Bun server handle (from Bun.serve).
 */
export interface BunServer {
  /**
   * Stops the server gracefully.
   */
  stop(): void;
  /**
   * Upgrades an inbound request to a WebSocket.
   *
   * Optional so a host injected before this seam existed still satisfies the
   * interface; when absent, the adapter refuses upgrades with 501.
   *
   * @param request - The native, undisturbed upgrade request
   * @param options - Per-socket data and response headers for the handshake
   * @returns `true` when the upgrade succeeded and no response should be sent
   */
  upgrade?(
    request: Request,
    options: { data: BunSocketData; headers?: Headers },
  ): boolean;
}

/**
 * Default Bun host built from the real `Bun` global.
 * Only evaluated when no host is injected.
 *
 * This is the ONE sanctioned boundary cast for this module.
 */
const defaultBunServeHost: BunServeHost = (globalThis as { Bun?: BunServeHost })
  .Bun! as BunServeHost;

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/**
 * Internal handle for a Bun HTTP server.
 *
 * @internal - Not exported from package index
 */
export class BunHttpServerHandle {
  #handler: ((request: IRequest) => Promise<IResponse>) | null = null;
  #server: BunServer | null = null;
  readonly #upgrades = new UpgradeRouterStore();
  readonly #rpcStore = new RpcInterceptorStore();

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
   * Gets the underlying Bun server (after listen is called).
   */
  get server(): BunServer | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: BunServer | null) {
    this.#server = value;
  }

  /**
   * Creates the plain HTTP fetch handler — the entry point used by
   * `IHttpAdapter.fetch`, which always answers with a `Response`.
   *
   * The RPC interceptor is consulted first; a returned Response short-circuits
   * as RPC, while null falls through to the normal Hono pipeline.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      // First check RPC interceptor — a Response short-circuits as RPC, null falls through
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
   * Creates the callback handed to `Bun.serve`. It differs from
   * {@linkcode BunHttpServerHandle.createFetchHandler} in exactly one way: it
   * may resolve `undefined`, which is how Bun is told a request was upgraded
   * to a WebSocket and needs no response. WebSocket upgrades are therefore
   * only available through `listen()`, not through `IHttpAdapter.fetch`.
   *
   * The RPC interceptor is deliberately NOT consulted here: `httpHandler`
   * already consults it, and doing so twice would dispatch every request
   * through the RPC handler twice. A handler that inspects the body before
   * returning `null` would then see an already-disturbed body on the second
   * call, throw, and be converted to a `500` — turning an ordinary non-RPC
   * POST into a server error.
   */
  createServeCallback(): (
    request: Request,
    server: BunServer,
  ) => Promise<Response | undefined> {
    const httpHandler = this.createFetchHandler();
    return async (request: Request, server: BunServer): Promise<Response | undefined> => {
      // First check WebSocket upgrades (short-circuits if upgraded)
      const upgradeDecision = await this.#upgrades.consult(request);
      if (upgradeDecision !== null) {
        if (!upgradeDecision.accept) {
          return new Response(null, { status: upgradeDecision.status });
        }
        if (server.upgrade === undefined) {
          upgradeDecision.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Upgrade unsupported' });
          return new Response(null, { status: 501 });
        }

        const headers = new Headers();
        if (upgradeDecision.protocol !== undefined) {
          headers.set('sec-websocket-protocol', upgradeDecision.protocol);
        }
        const upgraded = server.upgrade(request, { data: { sink: upgradeDecision.sink }, headers });
        if (upgraded) {
          // `undefined` tells Bun the socket was taken over.
          return undefined;
        }
        // Bun refused after the router accepted, so release whatever the
        // consumer reserved for this socket before answering.
        upgradeDecision.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Handshake refused' });
        return new Response(null, { status: 400 });
      }

      // RPC is consulted inside httpHandler — see the note above.
      return await httpHandler(request);
    };
  }
}

/**
 * Type guard to check if a handle is a BunHttpServerHandle.
 *
 * @param handle - The handle to check
 * @returns True if the handle is a BunHttpServerHandle
 */
export function isBunHttpServerHandle(handle: ServerHandle): handle is BunHttpServerHandle {
  return handle instanceof BunHttpServerHandle;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Bun HTTP adapter implementation.
 *
 * @param host - Injected Bun serve host (defaults to real Bun global)
 */
export class BunHttpAdapter implements IHttpAdapter {
  #host: BunServeHost;
  #handle: BunHttpServerHandle;

  constructor(host?: BunServeHost) {
    this.#host = host ?? defaultBunServeHost;
    this.#handle = new BunHttpServerHandle();
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
    const server = this.#host.serve({
      port,
      ...(hostname !== undefined ? { hostname } : {}),
      fetch: this.#handle.createServeCallback(),
      websocket: createBunWebSocketHandlers(),
    });

    this.#handle.server = server;
    return this.#handle;
  }

  close(handle: ServerHandle): Promise<void> {
    if (!isBunHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for BunHttpAdapter');
    }

    if (handle.server !== null) {
      handle.server.stop();
      handle.server = null;
    }
    return Promise.resolve();
  }
}
