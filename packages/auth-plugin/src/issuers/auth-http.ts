/**
 * Default outbound HTTP seam for issuer key sets and discovery documents.
 *
 * @module
 */

import type { IAuthHttp } from '../interfaces/index.ts';

/** Fetch-shaped function the default seam calls. */
export type AuthFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Thrown by the default seam when a response body exceeds its byte limit.
 * Internal: the key-set cache treats it as a refresh failure.
 */
export class AuthHttpBodyTooLargeError extends Error {
  override readonly name = 'AuthHttpBodyTooLargeError';

  /**
   * @param maxBytes - The limit the body exceeded
   */
  constructor(maxBytes: number) {
    super(`auth-plugin: response body exceeds ${maxBytes} bytes`);
  }
}

/**
 * Creates the default `IAuthHttp` over `fetch`.
 *
 * The body is read from its stream with a running byte total; the moment the
 * total passes `maxBytes` the stream is CANCELLED (never abandoned) and the call
 * rejects. `text()` is never used, because a limit checked on a finished string
 * has already buffered the body it exists to refuse. Redirects are NOT followed
 * (`redirect: 'manual'`), so a validated `https` URL cannot be bounced to another
 * scheme or host: the redirect response itself comes back, and its non-200
 * status is refused by the caller. `'manual'` rather than `'error'` because
 * Cloudflare Workers throws on `'error'` ("won't be implemented … at the edge"),
 * which would fail every key-set fetch there.
 *
 * @param fetchFn - Fetch implementation; defaults to the global `fetch`,
 *   resolved at call time with the global as receiver
 * @returns The HTTP seam
 */
export function createDefaultAuthHttp(
  fetchFn: AuthFetch = (input, init) => globalThis.fetch(input, init),
): IAuthHttp {
  return {
    async get(url, { signal, maxBytes }) {
      const response = await fetchFn(url, {
        method: 'GET',
        signal,
        redirect: 'manual',
        headers: { accept: 'application/json' },
      });
      const body = await readCapped(response.body, maxBytes);
      return { status: response.status, body };
    },
  };
}

/**
 * Reads a body stream as UTF-8 text, refusing past `maxBytes`.
 *
 * @param stream - The body, or `null` for an empty body
 * @param maxBytes - Maximum bytes to accept
 * @returns The decoded text
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (stream === null) {
    return '';
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AuthHttpBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
