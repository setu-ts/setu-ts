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

import type { HttpMethod, IRequest, ResponseSnapshot } from '@hono-enterprise/common';

// Hoisted TextDecoder — avoids per-call allocation (A1 — no slice needed).
const decoder = new TextDecoder();

/**
 * Maps a web-standard `Request` to the framework's `IRequest`.
 * Pre-reads the body via `arrayBuffer()` for idempotent access.
 * Forwards the native `Request.signal` so client disconnects can abort producers.
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
    // Forward the native Request.signal so the producer can stop on client
    // disconnect (M42 streaming primitive).
    signal: request.signal,
    // deno-lint-ignore require-await
    json: async <T = unknown>(): Promise<T> => {
      const text = decoder.decode(bodyBytes);
      return JSON.parse(text) as T;
    },
    // deno-lint-ignore require-await
    text: async (): Promise<string> => {
      return decoder.decode(bodyBytes);
    },
    // deno-lint-ignore require-await
    bytes: async (): Promise<Uint8Array> => {
      return bodyBytes;
    },
  };

  return result;
}

/**
 * Maps an `IResponse.snapshot()` to a web-standard `Response`.
 *
 * Accepts the discriminated {@linkcode ResponseSnapshot} union: when
 * `streaming` is `true`, the `ReadableStream` body is passed straight
 * through to `new Response(streamBody, { status, headers })` with zero
 * buffering. On the buffered arm, the existing logic is unchanged.
 *
 * @param snapshot - The response snapshot
 * @returns A web-standard `Response`
 */
export function mapSnapshotToWebResponse(
  snapshot: ResponseSnapshot,
): Response {
  const { status, headers, body, streaming } = snapshot;

  if (streaming) {
    // Pass the ReadableStream straight through — the web fetch model pumps it
    // lazily on every platform (Node/Deno/Bun/Workers) with no buffer-then-send.
    // ReadableStream<Uint8Array> is a valid BodyInit, so no cast needed.
    return new Response(body, { status, headers });
  }

  // Buffered path — unchanged from M23.
  // Uint8Array can be passed directly to Response constructor (A1 — no slice needed).
  // Cast to BlobPart (which Response accepts) to satisfy Deno's stricter ArrayBufferView type.
  const bodyPart: string | BlobPart | null = body === null
    ? null
    : (typeof body === 'string' ? body : body as unknown as BlobPart);

  // Pass the Headers object directly — preserves multi-valued Set-Cookie headers (C2)
  return new Response(bodyPart, {
    status,
    headers,
  });
}
