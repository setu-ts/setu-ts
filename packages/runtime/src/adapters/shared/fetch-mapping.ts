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

// Hoisted TextDecoder — avoids per-call allocation (A1 — no slice needed).
const decoder = new TextDecoder();

/** Shared empty body — a bodyless request allocates nothing. */
const EMPTY_BODY = new Uint8Array(0);

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
  #headers: Headers | undefined;

  constructor(raw: Request, method: HttpMethod, url: string, path: string) {
    this.#raw = raw;
    this.method = method;
    this.url = url;
    this.path = path;
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

  /** Reads and parses the body as JSON. Idempotent. */
  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
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
    return this.#raw.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
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
 * @returns The framework request
 */
export function mapWebRequestToFrameworkRequest(request: Request): IRequest {
  return new FrameworkRequest(
    request,
    request.method.toUpperCase() as HttpMethod,
    request.url,
    extractPath(request.url),
  );
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
  const { status, body, streaming } = snapshot;
  // Consult the kernel's typed init protocol before public `headers`: reading
  // that live view materializes a framework Headers object, while the common
  // terminal-response shapes can hand their immutable init straight to the
  // native Response constructor. Explicit/multi-value headers fall back to
  // the existing Headers path unchanged.
  const headers = snapshot.responseInit?.headers ?? snapshot.headers;

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
