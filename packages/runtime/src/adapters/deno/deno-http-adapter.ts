/**
 * Deno HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * Deno's `Deno.serve` API.
 *
 * @module
 */

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import { mapDenoRequest, mapSnapshotToDenoResponse } from './deno-http-mapping.ts';

/**
 * Internal handle for a Deno HTTP server.
 *
 * @internal - Not exported from package index
 */
export class DenoHttpServerHandle {
  readonly #handler: (request: IRequest) => Promise<IResponse>;
  #server: Deno.HttpServer | null = null;

  constructor(handler: (request: IRequest) => Promise<IResponse>) {
    this.#handler = handler;
  }

  /**
   * Gets the underlying Deno.HttpServer (after listen is called).
   */
  get server(): Deno.HttpServer | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: Deno.HttpServer | null) {
    this.#server = value;
  }

  /**
   * Creates the handler function for Deno.serve.
   */
  createDenoHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const frameworkRequest = mapDenoRequest(request);
      const frameworkResponse = await this.#handler(frameworkRequest);
      return mapSnapshotToDenoResponse(frameworkResponse.snapshot());
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

/**
 * Deno HTTP adapter implementation.
 */
export class DenoHttpAdapter implements IHttpAdapter {
  createServer(handler: (request: IRequest) => Promise<IResponse>): ServerHandle {
    return new DenoHttpServerHandle(handler);
  }

  listen(handle: ServerHandle, port: number, hostname?: string): Promise<void> {
    if (!isDenoHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for DenoHttpAdapter');
    }

    const denoHandler = handle.createDenoHandler();

    const server = Deno.serve(
      {
        port,
        hostname: hostname ?? '0.0.0.0',
      },
      denoHandler,
    );

    handle.server = server;
    return Promise.resolve();
  }

  async close(handle: ServerHandle): Promise<void> {
    if (!isDenoHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for DenoHttpAdapter');
    }

    if (handle.server !== null) {
      await handle.server.shutdown();
      handle.server = null;
    }
  }
}
