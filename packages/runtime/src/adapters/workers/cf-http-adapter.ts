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
  ServerHandle,
  WebSocketUpgradeRouter,
} from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
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
   * Creates the web-standard fetch handler.
   *
   * The upgrade is consulted first so the request body is never read before a
   * handshake, matching the ordering every other adapter uses.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const upgraded = await this.#tryUpgrade(request);
      if (upgraded !== null) {
        return upgraded;
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

    // Resolved lazily so the Workers-global boundary cast is never evaluated on
    // a runtime that has no WebSocketPair.
    this.#wsHost ??= createDefaultCloudflareWebSocketHost();

    const { client, server } = this.#wsHost.createPair();
    bindCloudflareSocketToSink(server, decision.sink);
    return this.#wsHost.createUpgradeResponse(client, decision.protocol);
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
