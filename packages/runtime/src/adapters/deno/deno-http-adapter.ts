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

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';

// ---------------------------------------------------------------------------
// Host seam
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the Deno `Deno.serve` operation.
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

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handler = handler;
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
    this.#handle = new DenoHttpServerHandle();
  }

  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handle.setHandler(handler);
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
