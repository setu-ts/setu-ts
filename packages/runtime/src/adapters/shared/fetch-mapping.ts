/**
 * Shared web-standard request/response mapping — translates between
 * web-standard `Request`/`Response` and the framework's `IRequest`/`IResponse`
 * snapshot.
 *
 * Every runtime adapter's `fetch` composes these two helpers. Body access is
 * **memoized-lazy**: nothing is read until a consumer asks, and the first read
 * is cached so `json()`/`text()`/`bytes()` stay idempotent (several first-party
 * middlewares read the body and then hand it to a handler that reads it again —
 * `session-plugin` CSRF, `validation-plugin`, and the kernel's own upgrade guard
 * followed by its gRPC dispatch).
 *
 * @module
 */

import type { HttpMethod, IRequest, ResponseSnapshot } from '@setu-ts/common';
import { parseJsonBody, withHttpStatusHint } from '@setu-ts/common';

// Hoisted TextDecoder — avoids per-call allocation (A1 — no slice needed).
const decoder = new TextDecoder();

/** Shared empty body — a bodyless request allocates nothing. */
const EMPTY_BODY = new Uint8Array(0);

/**
 * Raised when a request body exceeds the configured
 * {@linkcode RuntimeOptions.maxBodyBytes} cap.
 *
 * Branded with a `413` {@linkcode withHttpStatusHint HTTP status hint}, so an
 * application running `errorHandler` answers `413 Content Too Large` in its
 * configured format rather than the masked `500` an unbranded throw from this
 * depth would produce. The brand's `detail` names the limit and never the
 * observed size: the observed size is only ever a lower bound (the read stops
 * at the cap), so reporting it would be misleading.
 *
 * @since 0.5.0
 */
export class RequestBodyTooLargeError extends Error {
  /** The configured cap, in bytes. */
  readonly maxBodyBytes: number;

  /**
   * Builds the refusal for a body that exceeded the configured cap.
   *
   * @param maxBodyBytes - The configured cap that was exceeded
   */
  constructor(maxBodyBytes: number) {
    super(
      `Request body exceeds the configured maximum of ${maxBodyBytes} bytes ` +
        '(RuntimePlugin({ maxBodyBytes }))',
    );
    this.name = 'RequestBodyTooLargeError';
    this.maxBodyBytes = maxBodyBytes;
    withHttpStatusHint(this, {
      status: 413,
      // `'Payload Too Large'` rather than RFC 9110's newer
      // `'Content Too Large'`: it is what `@setu-ts/exceptions` maps 413 to,
      // and what `requestSizeMiddleware` already reports for the same
      // condition. A Problem Details formatter derives `title` from the status
      // anyway, so a different string here would only make the two 413 sites
      // disagree in the `'default'` format.
      title: 'Payload Too Large',
      detail: `Request body exceeds the maximum of ${maxBodyBytes} bytes.`,
    });
  }
}

/**
 * The framework request, as a class so that every accessor and body method
 * lives on ONE shared prototype.
 *
 * This shape is load-bearing rather than stylistic. The pre-M87 mapping built a
 * fresh object literal per request carrying three closures, which gave every
 * request its own hidden class and made these call sites megamorphic. Defining
 * the same members once on a prototype is the discipline `@hono/node-server`
 * and Fastify both use for their own per-request objects.
 */
class FrameworkRequest implements IRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly path: string;

  readonly #raw: Request;
  #body: Promise<Uint8Array> | undefined;
  #json: Promise<unknown> | undefined;
  #headers: Headers | undefined;
  readonly #maxBodyBytes: number | undefined;

  constructor(
    raw: Request,
    method: HttpMethod,
    url: string,
    path: string,
    maxBodyBytes?: number,
  ) {
    this.#raw = raw;
    this.method = method;
    this.url = url;
    this.path = path;
    this.#maxBodyBytes = maxBodyBytes;
  }

  /**
   * Request headers, copied on first read.
   *
   * The copy is NOT about immutability — a `new Headers(...)` is mutable, so it
   * provides the opposite. What it provides is a **writable** headers object on
   * every runtime: a server-received `Request` on Deno THROWS `TypeError` on
   * `headers.set()` (probed), while Node's `@hono/node-server` facade and Bun
   * both allow it. Handing the native object through would make a
   * header-writing middleware work on two runtimes and throw on a third.
   *
   * It is taken lazily because most requests never touch it, and on Node an
   * eager copy also defeats `@hono/node-server`'s lazy raw-header lookup by
   * forcing `materializeHeaders()`.
   */
  get headers(): Headers {
    this.#headers ??= new Headers(this.#raw.headers);
    return this.#headers;
  }

  /**
   * The undisturbed raw Request, for WebSocket upgrade and gRPC dispatch after
   * the middleware pipeline (M70a). Genuinely undisturbed now: the mapping no
   * longer consumes the body, so `bodyUsed` stays `false` until a consumer asks.
   */
  get raw(): Request {
    return this.#raw;
  }

  /**
   * The native abort signal, read lazily.
   *
   * On Node, `@hono/node-server`'s lightweight Request creates its
   * `AbortController` on first `signal` access, so reading it eagerly cost one
   * controller per request even for the majority of handlers that never abort.
   */
  get signal(): AbortSignal {
    return this.#raw.signal;
  }

  /**
   * Reads the body as raw bytes, once.
   *
   * The cache holds the in-flight PROMISE, not the resolved bytes, and is
   * assigned synchronously before any caller can interleave. Caching the
   * resolved value instead leaves a race: two concurrent readers both see an
   * empty cache, both call `Request.arrayBuffer()`, and because a non-empty
   * fetch body is one-shot the second rejects with `Body already consumed` —
   * so `Promise.all([request.text(), request.bytes()])` threw. Sequential
   * reads never showed it, which is why it shipped.
   *
   * A rejection stays cached deliberately: the body is one-shot, so a retry
   * cannot succeed, and re-reading would report a different failure than the
   * first caller saw.
   */
  bytes(): Promise<Uint8Array> {
    return this.#body ??= this.#readBody();
  }

  /** Reads the body as UTF-8 text. Idempotent. */
  async text(): Promise<string> {
    return decoder.decode(await this.bytes());
  }

  /**
   * Reads and parses the body as JSON. Idempotent.
   *
   * The parse is the shared `parseJsonBody` (X37-1): a malformed body rejects
   * with the `400`-branded `MalformedRequestBodyError` instead of the bare
   * `SyntaxError` that reached `errorHandler` as a masked `500`. The
   * rejection is cached like any body outcome — the body is one-shot, so a
   * second reader must observe the same failure, not a different one.
   */
  json<T = unknown>(): Promise<T> {
    return (this.#json ??= this.text().then((text) => parseJsonBody(text))) as Promise<T>;
  }

  /**
   * Resolves the body bytes, skipping the read entirely when the request cannot
   * carry one.
   *
   * The discriminator is the framing headers, NOT `raw.body === null`: reading
   * `.body` is not a cheap null check, because on Node it materializes the full
   * undici `Request` that the lightweight facade exists to avoid — measured at
   * roughly a quarter of the win. It is not the method alone either, because a
   * GET that does carry a body must still be read, or the kernel's
   * upgrade-with-body refusal (M70a §3.6) silently stops working.
   */
  #readBody(): Promise<Uint8Array> {
    // Read the framing headers off the NATIVE request, never `this.headers`:
    // the latter would take the lazy copy on every request and undo it.
    const native = this.#raw.headers;
    const bodyless = (this.method === 'GET' || this.method === 'HEAD') &&
      native.get('content-length') === null &&
      native.get('transfer-encoding') === null;
    if (bodyless) return Promise.resolve(EMPTY_BODY);
    if (this.#maxBodyBytes === undefined) {
      // No cap configured — the released path, byte for byte. `arrayBuffer()`
      // is also the cheapest read on every runtime, so an application that
      // sets no limit pays nothing for the option's existence.
      return this.#raw.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    }
    return readBounded(this.#raw, this.#maxBodyBytes);
  }
}

/**
 * Reads a request body, refusing past a byte cap.
 *
 * This is the bound that a request header cannot switch off.
 * `requestSizeMiddleware` refuses on a declared `Content-Length` before
 * anything is read, which is cheaper and reports earlier — but a chunked
 * request declares no length, and since M87 made the body lazy the read
 * happens inside the handler, AFTER every middleware has returned. So the only
 * place a chunked body can be bounded is where it is actually consumed.
 *
 * The cap is compared against the running total BEFORE a chunk is retained, so
 * at most one chunk beyond the limit is ever held. The reader is cancelled on
 * refusal rather than merely abandoned: an abandoned `ReadableStream` holds its
 * source open (the M70k HEAD-descriptor-leak class), which on a server means
 * the connection stays draining.
 *
 * `raw.body` is read only on this path. That matters on Node, where touching
 * `.body` materializes the full undici `Request` the lightweight facade exists
 * to avoid (M87) — which is why the uncapped branch above never reaches it.
 *
 * @param raw - The web-standard request
 * @param maxBodyBytes - The cap, in bytes
 * @returns The body bytes
 * @throws {RequestBodyTooLargeError} When the body exceeds the cap
 */
async function readBounded(raw: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const stream = raw.body;
  if (stream === null) {
    // Framing headers were present but there is no stream: an empty body.
    return EMPTY_BODY;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBodyBytes) {
        throw new RequestBodyTooLargeError(maxBodyBytes);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    // Releasing the lock is not enough — the source stays open until the
    // stream is cancelled. `cancel()` rejects on an already-errored stream,
    // which must not replace the refusal with a different failure.
    await reader.cancel().catch(() => {});
  }

  // One chunk is the overwhelmingly common case; returning it directly avoids
  // a full copy of every uploaded body.
  if (chunks.length === 1) {
    return chunks[0] as Uint8Array;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Extracts the path from an absolute request URL without constructing a
 * `URL`, falling back to one on the only inputs where the two could differ.
 *
 * `new URL(u).pathname` was the last full URL parse left on the request path
 * (M87), and it is pure overhead for the overwhelming majority of traffic:
 * the only rewriting `URL` performs on a path is resolving dot-segments
 * (`/a/../b` becomes `/b`, `/a/./b` becomes `/a/b`) and turning backslashes
 * into forward slashes. It does NOT percent-decode and it does NOT collapse
 * empty segments — `/a%2Fb` and `//a` both survive verbatim.
 *
 * The slice is therefore returned as-is unless it contains `/.`, a backslash,
 * or a percent-encoded dot (`%2e`/`%2E`), where `URL` decides instead. The
 * encoded forms are load-bearing rather than defensive: WHATWG resolves
 * `%2e%2e` as a dot-segment, so `/%2e%2e/admin` normalizes to `/admin`, and a
 * guard testing only literal dots answered `/%2e%2e/admin` — a routing
 * divergence, found by probing this function against `URL` over a corpus
 * rather than by reading it. The authority scan stops at the first `/`, `?`
 * or `#` for the same reason: scanning for `/` alone let a slash inside a
 * query pose as the path.
 *
 * With those guards this equals `new URL(url).pathname` for every input,
 * which is what separates it from the string-slicing `getPath` Hono uses:
 * that one stops normalizing dot-segments, so `/foo/../admin` would cease to
 * resolve to `/admin` and would route somewhere else. Nothing here changes
 * routing.
 *
 * An encoded dot-segment (`/a/..%2fb`) trips the guard and takes the fallback
 * although the answer is unchanged — a wasted parse on a rare input, never a
 * wrong result.
 *
 * @param url - An absolute request URL
 * @returns The path, identical to `new URL(url).pathname`
 */
export function extractPath(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) {
    return new URL(url).pathname;
  }
  // The authority ends at the first '/', '?' or '#'. Scanning for '/' alone
  // would let a slash inside a query or fragment pose as the path, so
  // `http://host?next=/admin` answered '/admin' where `URL` answers '/'.
  let start = -1;
  for (let i = schemeEnd + 3; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code === 47) {
      start = i;
      break;
    }
    // '?' (63) or '#' (35) before any '/' means there is no path at all.
    if (code === 63 || code === 35) {
      return '/';
    }
  }
  if (start === -1) {
    return '/';
  }
  let end = url.length;
  for (let i = start; i < end; i++) {
    const code = url.charCodeAt(i);
    // '?' (63) or '#' (35) ends the path.
    if (code === 63 || code === 35) {
      end = i;
      break;
    }
  }
  const path = url.slice(start, end);
  if (
    path.includes('/.') || path.includes('\\') ||
    path.includes('%2e') || path.includes('%2E')
  ) {
    return new URL(url).pathname;
  }
  return path;
}

/**
 * Maps a web-standard `Request` to the framework's `IRequest`.
 *
 * Body access is memoized-lazy — see {@linkcode FrameworkRequest}, so the
 * mapping itself awaits nothing and is SYNCHRONOUS. That matters beyond the
 * saved microtask: `@hono/node-server` reaches its `responseViaCache` fast
 * path only when the fetch callback returns a `Response` rather than a
 * promise, so every eagerly-async link in this chain forecloses it.
 *
 * @param request - A web-standard `Request`
 * @param maxBodyBytes - Optional cap on the body read, in bytes. Omitted, the
 *   body is read unbounded — the released behaviour. Supplied, a body past the
 *   cap rejects with {@linkcode RequestBodyTooLargeError}, which no request
 *   header can disable. `RuntimePlugin({ maxBodyBytes })` is what threads it
 *   here.
 * @returns The framework request
 */
export function mapWebRequestToFrameworkRequest(
  request: Request,
  maxBodyBytes?: number,
): IRequest {
  return new FrameworkRequest(
    request,
    request.method.toUpperCase() as HttpMethod,
    request.url,
    extractPath(request.url),
    maxBodyBytes,
  );
}

/**
 * The statuses RFC 9110 defines as carrying no content, which the `Response`
 * constructor enforces by throwing
 * `TypeError: Response with null body status cannot have body`.
 *
 * The framework's own response model does not prevent a handler from writing a
 * body at one of these — `ctx.response.status(204).json(...)` is expressible,
 * and so is the far likelier `status(204).send(new Uint8Array(0))` or
 * `status(204).text('')`, where the body is EMPTY but still present. Before
 * this was handled, every one of those threw out of the adapter, after the
 * pipeline had finished, so no middleware and no `errorHandler` could see it:
 * the request died with an unhandled `TypeError`.
 *
 * The body is therefore dropped rather than the throw being propagated, which
 * is what Express and Fastify both do and what RFC 9110 §15.3.5 implies — a
 * `204` has no content, so serving it without one is the conformant answer.
 * Headers are left alone: RFC 9110 permits representation metadata on a `204`.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Maps an `IResponse.snapshot()` to a web-standard `Response`.
 *
 * Accepts the discriminated {@linkcode ResponseSnapshot} union: when
 * `streaming` is `true`, the `ReadableStream` body is passed straight
 * through to `new Response(streamBody, { status, headers })` with zero
 * buffering. On the buffered arm, the existing logic is unchanged.
 *
 * A body written at one of the {@linkcode NULL_BODY_STATUSES} is dropped, and
 * a stream body is CANCELLED rather than merely discarded, so the source it
 * reads from (a file handle, an upstream response) is released instead of
 * leaking.
 *
 * @param snapshot - The response snapshot
 * @returns A web-standard `Response`
 */
export function mapSnapshotToWebResponse(
  snapshot: ResponseSnapshot,
): Response {
  const { status, body, streaming } = snapshot;
  // Consult the kernel's typed init protocol before public `headers`: reading
  // that live view materializes a framework Headers object, while the common
  // terminal-response shapes can hand their snapshot-local init straight to
  // the native Response constructor. Explicit/multi-value headers fall back
  // to the existing Headers path unchanged.
  const headers = snapshot.responseInit?.headers ?? snapshot.headers;

  if (NULL_BODY_STATUSES.has(status)) {
    // Cancelling is not tidiness: an abandoned `ReadableStream` holds its
    // source open (the M70k HEAD-descriptor-leak class). `cancel()` rejects if
    // the stream is already errored or locked, which must not replace a valid
    // response with a throw, so the rejection is swallowed.
    if (streaming && body !== null) {
      void body.cancel().catch(() => {});
    }
    return new Response(null, { status, headers });
  }

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
