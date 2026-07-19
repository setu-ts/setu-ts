/**
 * Cloudflare Workers HTTP adapter — implements {@linkcode IHttpAdapter} for
 * the CF Workers model where `fetch` is the sole entry point.
 *
 * `fetch` works using the shared web-standard mapping. `listen` throws
 * (CF Workers has no `listen(port)` model). `close` is a no-op.
 *
 * @module
 */

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';

/**
 * Internal handle for a Cloudflare Workers HTTP server.
 *
 * @internal - Not exported from package index
 */
export class CloudflareWorkersServerHandle {
  #handler: ((request: IRequest) => Promise<IResponse>) | null = null;

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handler = handler;
  }

  /**
   * Creates the web-standard fetch handler.
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const frameworkRequest = await mapWebRequestToFrameworkRequest(request);
      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }
      const frameworkResponse = await this.#handler(frameworkRequest);
      return mapSnapshotToWebResponse(frameworkResponse.snapshot());
    };
  }
}

/**
 * Cloudflare Workers HTTP adapter implementation.
 *
 * `fetch` works, `listen` throws (CF Workers has no socket model), `close`
 * is a no-op. Deployers export `export default { fetch: app.fetch }`.
 */
export class CloudflareWorkersHttpAdapter implements IHttpAdapter {
  #handle: CloudflareWorkersServerHandle;

  constructor() {
    this.#handle = new CloudflareWorkersServerHandle();
  }

  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handle.setHandler(handler);
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
