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

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';

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
   * @param options - Server options
   * @returns The server handle
   */
  serve(options: {
    port: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
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

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void {
    this.#handler = handler;
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
   * Creates the fetch handler for Bun.serve.
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

  fetch(request: Request): Promise<Response> {
    return this.#handle.createFetchHandler()(request);
  }

  // deno-lint-ignore require-await
  async listen(port: number, hostname?: string): Promise<ServerHandle> {
    const fetchHandler = this.#handle.createFetchHandler();
    const server = this.#host.serve({
      port,
      ...(hostname !== undefined ? { hostname } : {}),
      fetch: fetchHandler,
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
