/**
 * Node HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * Node's `node:http` API.
 *
 * Uses static `node:` imports (supported by Deno, Node, and Bun).
 *
 * @module
 */

import type { IHttpAdapter, IRequest, IResponse, ServerHandle } from '@hono-enterprise/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mapNodeRequest, writeSnapshotToNodeResponse } from './node-http-mapping.ts';

/**
 * Internal handle for a Node HTTP server.
 *
 * @internal - Not exported from package index
 */
export class NodeHttpServerHandle {
  readonly #handler: (request: IRequest) => Promise<IResponse>;
  #server: Server | null = null;

  constructor(handler: (request: IRequest) => Promise<IResponse>) {
    this.#handler = handler;
  }

  /**
   * Gets the underlying http.Server (after listen is called).
   */
  get server(): Server | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: Server | null) {
    this.#server = value;
  }

  /**
   * Creates the request listener for http.Server.
   */
  createNodeRequestListener(): (req: IncomingMessage, res: ServerResponse) => void {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      // Read body as bytes first (for idempotent body access)
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      }
      const bodyBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const frameworkRequest = mapNodeRequest(req, bodyBytes);
      const frameworkResponse = await this.#handler(frameworkRequest);
      writeSnapshotToNodeResponse(frameworkResponse.snapshot(), res);
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

/**
 * Node HTTP adapter implementation.
 */
export class NodeHttpAdapter implements IHttpAdapter {
  createServer(handler: (request: IRequest) => Promise<IResponse>): ServerHandle {
    return new NodeHttpServerHandle(handler);
  }

  listen(handle: ServerHandle, port: number, hostname?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!isNodeHttpServerHandle(handle)) {
        reject(new Error('Invalid server handle for NodeHttpAdapter'));
        return;
      }

      const requestListener = handle.createNodeRequestListener();
      const server = createServer(requestListener);

      server.on('listening', () => {
        handle.server = server;
        resolve();
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(port, hostname);
    });
  }

  close(handle: ServerHandle): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!isNodeHttpServerHandle(handle)) {
        reject(new Error('Invalid server handle for NodeHttpAdapter'));
        return;
      }

      if (handle.server === null) {
        // Never listened, nothing to close
        resolve();
        return;
      }

      handle.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        handle.server = null;
        resolve();
      });
    });
  }
}
