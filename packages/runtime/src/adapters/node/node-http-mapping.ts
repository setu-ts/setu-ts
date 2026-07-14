/**
 * Node HTTP request/response mapping — translates between native Node
 * `IncomingMessage`/`ServerResponse` and the framework's `IRequest`/`IResponse` snapshot.
 *
 * These functions are pure and testable without Node-specific permissions.
 *
 * @module
 */

import type { HttpMethod, IRequest } from '@hono-enterprise/common';
import { Readable } from 'node:stream';

/**
 * Reads the body from an IncomingMessage as bytes.
 *
 * @param message - The incoming message
 * @returns The body bytes
 */
async function readBodyAsBytes(message: NodeIncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Readable.toWeb(message) as ReadableStream<Uint8Array>) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Type alias for IncomingMessage to avoid import collision
type NodeIncomingMessage = import('node:http').IncomingMessage;
type NodeServerResponse = import('node:http').ServerResponse;

/**
 * Maps a native Node `IncomingMessage` to the framework's `IRequest`.
 *
 * @param message - The native Node incoming message
 * @param bodyBytes - The pre-read body bytes (for idempotent body access)
 * @returns The framework request
 */
export function mapNodeRequest(
  message: NodeIncomingMessage,
  bodyBytes: Uint8Array,
): IRequest {
  const method = (message.method ?? 'GET').toUpperCase() as HttpMethod;
  const url = message.url ?? '/';
  const path = url.split('?')[0];

  // Convert Node headers to web-standard Headers
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v);
        }
      } else {
        headers.append(key, value);
      }
    }
  }

  // Client IP address
  const ip = message.socket?.remoteAddress;

  let cachedBody: Uint8Array | null = bodyBytes;

  const result: IRequest = {
    method,
    url,
    path,
    headers,
    ...(ip !== undefined ? { ip } : {}),
    json: async () => {
      const bytes = cachedBody ?? (await readBodyAsBytes(message));
      cachedBody = null;
      const text = new TextDecoder().decode(bytes);
      return JSON.parse(text);
    },
    text: async () => {
      const bytes = cachedBody ?? (await readBodyAsBytes(message));
      cachedBody = null;
      return new TextDecoder().decode(bytes);
    },
    bytes: async () => {
      const bytes = cachedBody ?? (await readBodyAsBytes(message));
      cachedBody = null;
      return bytes;
    },
  };

  return result;
}

/**
 * Writes an `IResponse.snapshot()` to a native Node `ServerResponse`.
 *
 * @param snapshot - The response snapshot
 * @param response - The native Node server response
 */
export function writeSnapshotToNodeResponse(
  snapshot: {
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array | string | null;
  },
  response: NodeServerResponse,
): void {
  const { status, headers, body } = snapshot;

  response.statusCode = status;

  // Set headers
  for (const [key, value] of headers.entries()) {
    response.setHeader(key, value);
  }

  // Write body
  if (body === null || body === undefined) {
    response.end();
  } else if (typeof body === 'string') {
    response.end(body);
  } else {
    response.end(body);
  }
}
