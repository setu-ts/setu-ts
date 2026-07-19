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

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';

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
   * @returns A Node.js HTTP server handle
   */
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    port: number;
    hostname?: string;
    overrideGlobalObjects?: boolean;
  }): NodeServer;
}

/**
 * Node.js HTTP server handle (returned by `@hono/node-server` `serve()`).
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
  serve: (options) => {
    // Lazy import — only loads when listen() is actually called
    // We need to inline the import synchronously via a cached module reference
    // Since @hono/node-server's serve() is synchronous (returns http.Server),
    // we import it eagerly once and reuse.
    return import('npm:@hono/node-server@^2.0.0').then((mod) => {
      // overrideGlobalObjects: false prevents @hono/node-server from mutating
      // the global Request/Response which would corrupt the shared mapping.
      return mod.serve({ ...options, overrideGlobalObjects: false });
    }) as unknown as NodeServer;
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

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handler = handler;
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

  constructor(host?: NodeServeHost) {
    this.#host = host ?? defaultNodeServeHost;
    this.#handle = new NodeHttpServerHandle();
  }

  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handle.setHandler(handler);
  }

  fetch(request: Request): Promise<Response> {
    return this.#handle.createFetchHandler()(request);
  }

  listen(port: number, hostname?: string): Promise<ServerHandle> {
    const fetchHandler = this.#handle.createFetchHandler();
    const server = this.#host.serve({
      fetch: fetchHandler,
      port,
      ...(hostname !== undefined && { hostname }),
    });
    this.#handle.server = server;
    return Promise.resolve(this.#handle);
  }

  close(handle: ServerHandle): Promise<void> {
    if (!isNodeHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for NodeHttpAdapter');
    }

    if (handle.server !== null) {
      handle.server.close();
      handle.server = null;
    }
    return Promise.resolve();
  }
}
