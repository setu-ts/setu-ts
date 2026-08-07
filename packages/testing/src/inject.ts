import type { IKernelApplication, InjectRequest, InjectResponse } from '@setu-ts/kernel';

/**
 * Parsed body returned by {@linkcode collectStream}.
 *
 * @since 0.1.0
 */
export interface StreamingBody {
  /** Individual chunks as they arrived from the stream. */
  chunks: Uint8Array[];
  /** The concatenated body decoded as UTF-8 text. */
  text: string;
}

/**
 * Collects a web `Response` body incrementally via a `ReadableStream` reader.
 *
 * Reads each chunk into `chunks`, decodes the concatenation into `text`
 * with `TextDecoder`. Throws if `response.body` is `null`.
 *
 * @param response - A streaming web Response
 * @returns The collected chunks and decoded text
 * @throws {Error} If `response.body` is null
 * @since 0.1.0
 */
export async function collectStream(response: Response): Promise<StreamingBody> {
  if (response.body === null) {
    throw new Error('collectStream: response body is null');
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = mergeChunks(chunks);
  const decoder = new TextDecoder();
  return { chunks, text: decoder.decode(merged) };
}

/**
 * Merges an array of `Uint8Array` chunks into a single buffer.
 */
function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// --- Free-function inject ---

/**
 * Normalizes a string request to an `InjectRequest`.
 * The string is treated as a **URL only** (not `"GET /path"` prefixed form).
 */
function normalizeStringRequest(request: string): InjectRequest {
  return { method: 'GET', url: request };
}

/**
 * Checks whether a value is a web-standard `Request`.
 */
function isWebRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

/**
 * Normalizes a web `Request` to an `InjectRequest`.
 *
 * Extracts `method`, `url` and `headers`, and reads the body via
 * `await request.text()` when the request carries one — that is, when the method
 * is not `GET`/`HEAD` **and** `request.body` is non-null. A `POST` with an empty
 * string body still carries a body (`''`), and the distinction is preserved: the
 * `body` key is present and empty rather than absent.
 *
 * @param request - A web-standard Request
 * @returns An equivalent InjectRequest
 * @throws {Error} If the request's body has already been consumed
 */
async function normalizeWebRequest(request: Request): Promise<InjectRequest> {
  const headers = Object.fromEntries(request.headers.entries());
  const base: InjectRequest = {
    method: request.method,
    url: request.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  const carriesBody = !['GET', 'HEAD'].includes(request.method.toUpperCase()) &&
    request.body !== null;
  if (!carriesBody) {
    return base;
  }

  // Fail fast, with the actual cause named. A `Request` body is a one-shot
  // stream, so reusing one across two calls (or across inject() and fetch())
  // makes the second read throw. Swallowing that and injecting no body instead
  // turned an obvious mistake into a confusing downstream failure — the handler
  // saw an empty payload and the test author had no clue why.
  if (request.bodyUsed) {
    throw new Error(
      'inject() cannot read this Request: its body has already been consumed. ' +
        'A Request body is one-shot — build a separate Request for each call ' +
        'rather than reusing one across inject() and fetch().',
    );
  }

  return { ...base, body: await request.text() };
}

/**
 * Free-function HTTP request injector with string, `InjectRequest`, and
 * web-standard `Request` shorthand.
 *
 * A `string` is a URL-only shorthand (`{ method: 'GET', url: request }`).
 * For non-GET methods, use the `InjectRequest` object form directly.
 * A web-standard `Request` is normalized field-by-field and delegated to
 * `app.inject()` after reading its body. That read **consumes** the request, so a
 * `Request` cannot be injected twice, nor injected and then passed to
 * `app.fetch()` — the second call throws rather than silently sending no body.
 * Build a separate `Request` per call.
 *
 * @example
 * ```typescript
 * import { inject } from '@setu-ts/testing';
 *
 * // String shorthand (GET only)
 * const res = await inject(app, '/users');
 *
 * // InjectRequest object
 * const res2 = await inject(app, {
 *   method: 'POST',
 *   url: '/users',
 *   body: { name: 'test' },
 * });
 *
 * // Web Request
 * const req = new Request('http://localhost/users', {
 *   method: 'POST',
 *   body: JSON.stringify({ name: 'test' }),
 * });
 * const res3 = await inject(app, req);
 * ```
 *
 * @param app - A started kernel application
 * @param request - String URL, InjectRequest object, or web Request
 * @returns The inject response
 * @since 0.1.0
 */
export async function inject(
  app: IKernelApplication,
  request: string | InjectRequest | Request,
): Promise<InjectResponse> {
  if (typeof request === 'string') {
    return app.inject(normalizeStringRequest(request));
  }

  if (isWebRequest(request)) {
    return app.inject(await normalizeWebRequest(request));
  }

  return app.inject(request);
}
