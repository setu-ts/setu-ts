/**
 * Cloudflare Workers HTTP adapter — implements {@linkcode IHttpAdapter} for
 * the CF Workers model where `fetch` is the sole entry point.
 *
 * `fetch` works using the shared web-standard mapping. `listen` throws
 * (CF Workers has no `listen(port)` model). `close` is a no-op. WebSocket
 * upgrades ride the same `fetch` path, short-circuiting before the request is
 * mapped.
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
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
import { ABNORMAL_CLOSURE } from '../shared/web-socket-transport.ts';
import type { CloudflareWebSocketHost } from './cf-ws-upgrader.ts';
import {
  bindCloudflareSocketToSink,
  createDefaultCloudflareWebSocketHost,
} from './cf-ws-upgrader.ts';

/**
 * Internal handle for a Cloudflare Workers HTTP server.
 *
 * @internal - Not exported from package index
 */
export class CloudflareWorkersServerHandle {
  #handler: ((request: IRequest) => Promise<IResponse>) | null = null;
  readonly #upgrades = new UpgradeRouterStore();
  #wsHost: CloudflareWebSocketHost | null;

  constructor(wsHost?: CloudflareWebSocketHost) {
    this.#wsHost = wsHost ?? null;
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
   * Creates the web-standard fetch handler.
   *
   * The framework handler (kernel pipeline) runs FIRST on every request.
   * After it returns, the adapter checks for an upgrade intent written by
   * the kernel terminal handler and performs the WebSocket handshake.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }

      // Run the framework handler FIRST — middleware pipeline applies uniformly.
      const frameworkResponse = await this.#handler(frameworkRequest);

      // Check for upgrade intent written by the kernel terminal handler.
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
   * Performs the WebSocket handshake using the Cloudflare WebSocketPair.
   */
  #performUpgrade(_request: Request, intent: WebSocketUpgradeIntent): Response {
    try {
      // Resolved lazily so the Workers-global boundary cast is never evaluated
      // on a runtime that has no WebSocketPair.
      this.#wsHost ??= createDefaultCloudflareWebSocketHost();

      const { client, server } = this.#wsHost.createPair();
      bindCloudflareSocketToSink(server, intent.sink);
      return this.#wsHost.createUpgradeResponse(client, intent.protocol);
    } catch (cause) {
      intent.sink.onClose({
        code: ABNORMAL_CLOSURE,
        reason: cause instanceof Error ? cause.message : 'Handshake failed',
      });
      return new Response(null, { status: 500 });
    }
  }
}

/**
 * Cloudflare Workers HTTP adapter implementation.
 *
 * `fetch` works, `listen` throws (CF Workers has no socket model), `close`
 * is a no-op. Deployers export `export default { fetch: app.fetch }`.
 *
 * @param wsHost - Injected WebSocket host (defaults to the real Workers globals)
 */
export class CloudflareWorkersHttpAdapter implements IHttpAdapter {
  #handle: CloudflareWorkersServerHandle;

  constructor(wsHost?: CloudflareWebSocketHost) {
    this.#handle = new CloudflareWorkersServerHandle(wsHost);
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

  listen(_port: number, _hostname?: string): Promise<ServerHandle> {
    throw new Error(
      'Cloudflare Workers has no listen(port) model — export default { fetch: app.fetch } instead',
    );
  }

  close(_handle: ServerHandle): Promise<void> {
    // No-op: there is no server handle to close on CF Workers.
    return Promise.resolve();
  }
}
