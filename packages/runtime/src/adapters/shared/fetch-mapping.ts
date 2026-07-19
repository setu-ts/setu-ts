/**
 * Shared web-standard request/response mapping — translates between
 * web-standard `Request`/`Response` and the framework's `IRequest`/`IResponse`
 * snapshot.
 *
 * Every runtime adapter's `fetch` composes these two helpers. The shared
 * mapping pre-reads the body into an `ArrayBuffer` so `json()`/`text()`/`bytes()`
 * are safely callable more than once (idempotent body access).
 *
 * @module
 */

import type { HttpMethod, IRequest } from '@hono-enterprise/common';

/**
 * Maps a web-standard `Request` to the framework's `IRequest`.
 * Pre-reads the body via `arrayBuffer()` for idempotent access.
 *
 * @param request - A web-standard `Request`
 * @returns The framework request
 */
export async function mapWebRequestToFrameworkRequest(request: Request): Promise<IRequest> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Create a copy of headers to ensure immutability
  const headers = new Headers(request.headers);

  // Cast to HttpMethod - the common package defines the supported methods
  const method = request.method.toUpperCase() as HttpMethod;

  // Pre-read body for idempotent access (web Request body is one-shot)
  const bodyBuffer = await request.arrayBuffer();
  const bodyBytes = new Uint8Array(bodyBuffer);

  const result: IRequest = {
    method,
    url: request.url,
    path,
    headers,
    // ip is deliberately NOT populated — a web Request carries no client IP.
    // Consumers needing the client IP must read X-Forwarded-For in their
    // own middleware. (Deliberated regression on the Node path.)
    // deno-lint-ignore require-await
    json: async (): Promise<unknown> => {
      const text = new TextDecoder().decode(bodyBytes);
      return JSON.parse(text);
    },
    // deno-lint-ignore require-await
    text: async (): Promise<string> => {
      return new TextDecoder().decode(bodyBytes);
    },
    // deno-lint-ignore require-await
    bytes: async (): Promise<Uint8Array> => {
      return bodyBytes;
    },
  } as IRequest;

  return result;
}

/**
 * Maps an `IResponse.snapshot()` to a web-standard `Response`.
 *
 * @param snapshot - The response snapshot
 * @returns A web-standard `Response`
 */
export function mapSnapshotToWebResponse(
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
