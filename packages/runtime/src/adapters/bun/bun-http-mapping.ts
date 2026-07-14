/**
 * Bun HTTP request/response mapping — translates between native Bun
 * `Request`/`Response` and the framework's `IRequest`/`IResponse` snapshot.
 *
 * These functions are pure and testable without Bun-specific permissions.
 *
 * @module
 */

import type { HttpMethod, IRequest } from '@hono-enterprise/common';

/**
 * Maps a native Bun `Request` to the framework's `IRequest`.
 *
 * @param request - The native Bun request
 * @returns The framework request
 */
export function mapBunRequest(request: Request): IRequest {
  const url = new URL(request.url);
  const path = url.pathname;

  // Create a copy of headers to ensure immutability
  const headers = new Headers(request.headers);

  // Cast to HttpMethod - the common package defines the supported methods
  const method = request.method.toUpperCase() as HttpMethod;

  return {
    method,
    url: request.url,
    path,
    headers,
    json: async () => {
      const body = await request.json();
      return body;
    },
    text: async () => {
      const body = await request.text();
      return body;
    },
    bytes: async () => {
      const body = await request.arrayBuffer();
      return new Uint8Array(body);
    },
  };
}

/**
 * Maps an `IResponse.snapshot()` to a native Bun `Response`.
 *
 * @param snapshot - The response snapshot
 * @returns The native Bun response
 */
export function mapSnapshotToBunResponse(
  snapshot: {
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array | string | null;
  },
): Response {
  const { status, headers, body } = snapshot;

  // Convert Headers to a plain object for the Response constructor
  const headersObj: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    headersObj[key] = value;
  }

  // Uint8Array needs to be wrapped for Response constructor
  const bodyInit = body === null ? null : (typeof body === 'string' ? body : body.slice(0));

  return new Response(bodyInit, {
    status,
    headers: headersObj,
  });
}
