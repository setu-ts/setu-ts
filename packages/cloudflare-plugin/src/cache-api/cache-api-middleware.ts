/**
 * Response caching over Cloudflare's own edge cache (`caches.default`).
 *
 * This is a **different layer** from `cache-plugin`'s `cacheMiddleware`, and
 * the two compose: this one serves from the colo the request landed in, with no
 * round trip to any store, while `cacheMiddleware` reads an `ICacheStore`
 * (KV, Redis, memory) that every colo shares. They are therefore reported under
 * different headers — `X-Cache-Api` here, `X-Cache` there — so an operator can
 * tell which layer answered.
 *
 * @module
 */

import type { ILogger, IRequestContext, IResponse, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { ICloudflareBindings } from '../bindings/binding-registry.ts';
import type { ICacheApi } from './cache-api.ts';
import { resolveCacheApi } from './cache-api.ts';
import { assessCacheability } from './cacheability.ts';

/** The header this middleware reports under. Never `X-Cache` — see the module doc. */
const STATUS_HEADER = 'X-Cache-Api';

/** Statuses cached when the caller configures none. */
const DEFAULT_CACHEABLE_STATUSES: readonly number[] = [200];

/**
 * Hop-by-hop headers, which are connection-specific and meaningless replayed.
 * The same set `cache-plugin` strips.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Options for {@linkcode cacheApiMiddleware}.
 *
 * @since 0.2.0
 */
export interface CacheApiMiddlewareOptions {
  /**
   * The cache handle. Omitted resolves `caches.default` from the global scope;
   * when that is also absent — every runtime other than Cloudflare Workers —
   * the middleware passes through instead of throwing.
   */
  readonly cache?: ICacheApi;
  /**
   * Builds the cache key from the request. Omitted uses the full request URL,
   * which is what the platform's own cache keys on — plus, when the request
   * carries a resolved `ctx.request.tenant` (the multi-tenancy plugin) and/or
   * `ctx.request.locale` (the localization plugin), a `setu-cache-tenant` and
   * a `setu-cache-locale` query parameter naming them, appended last. The key
   * is a URL STRING, so the platform matches it with no request headers and
   * `Vary` cannot separate entries here. The tenant and locale in the key are
   * the ones present when this middleware runs, so it must run AFTER the
   * tenant and locale middleware: a GLOBAL registration needs a higher
   * priority number than theirs (40 and 45 by default, or the configured
   * priorities); where either is applied per route instead, this one must be
   * too, listed after it; and a `replaceTenant` or `replaceLocale` made inside
   * the handler is not reflected — such a route must not be cached here. That
   * priority is a LOWER bound only: a global registration still runs before
   * passive authentication (300) and every guard, so a HIT is served without
   * them — inherent to global response caching, as with `cache-plugin`. A
   * response that depends on who is asking belongs behind a per-route
   * registration listed after its guards. A custom `key` replaces all of this
   * and must include the tenant and locale itself.
   */
  readonly key?: (ctx: IRequestContext) => string;
  /** Returning `true` skips the cache entirely for this request. */
  readonly bypass?: (ctx: IRequestContext) => boolean;
  /**
   * Statuses worth caching. Defaults to `[200]`. Does **not** override the
   * platform's unconditional refusal of 206.
   */
  readonly cacheableStatuses?: readonly number[];
  /**
   * Adds `Cache-Control: public, max-age=<n>` to the **stored copy** when the
   * response carries no `Cache-Control` of its own. The edge honors the stored
   * response's own directive, so without one an entry has no freshness lifetime
   * and is of little use. The client's response is left untouched.
   */
  readonly ttlSeconds?: number;
}

/**
 * The query parameters the default key appends for a request that carries a
 * resolved tenant and/or locale, in this order.
 *
 * Each is APPENDED to the request URL's own TEXT — never a re-serialized
 * query, and never a `set`. `set` would delete a client-supplied copy from
 * the key while the handler still sees it, letting any client fill the
 * canonical entry with a response reflecting its own input (web cache
 * poisoning); re-serializing the query would fold encoding variants together
 * (`?p=%32` with `?p=2`, `/page?&&` with `/page`), letting a client choose the
 * exact text a cached reflection of `ctx.request.url` carries. Concatenation
 * keeps every byte the client sent, and since an encoded value can contain
 * neither `&` nor `=`, the LAST occurrence of each name in a key always names
 * the request's own value: two different (URL, tenant, locale) triples never
 * share a key.
 */
const KEY_DISCRIMINATORS: readonly {
  readonly name: string;
  readonly read: (ctx: IRequestContext) => string | undefined;
}[] = [
  { name: 'setu-cache-tenant', read: (ctx) => ctx.request.tenant?.id },
  { name: 'setu-cache-locale', read: (ctx) => ctx.request.locale },
];

/**
 * The default cache key: the request URL, carrying the resolved tenant and
 * locale when there are any (M103 added the locale; the tenant followed from
 * its audit). Without either the key is the URL unchanged, so an application
 * without multi-tenancy or localization keeps byte-identical keys.
 *
 * Answers `undefined` — the request is then served uncached — whenever no
 * key can keep that request apart from another:
 *
 * - **the URL text is not in its parsed form.** Workers and Bun normalize the
 *   URL before the handler sees it, but Deno (and Node, for some targets)
 *   hand the handler the request target as sent — `/a/./b`, `/a\b`, a raw
 *   `"` or `<` in the query, an upper-case host — while the Cache API parses
 *   a key before it matches, so such a request would fill the entry its
 *   normalized sibling is served from with a response reflecting its own
 *   text. Comparing the text with its own serialization costs one URL parse.
 * - **the URL carries a fragment.** Deno, Node and Bun deliver one to the
 *   handler when a client sends it, while the Cache API ignores fragments when
 *   it matches, so `/page#x` would fill `/page`'s entry. A browser never
 *   sends a fragment, so nothing legitimate is lost; workerd strips it before
 *   the handler.
 * - **a tenant id or locale is not well-formed UTF-16** (a lone surrogate),
 *   which `encodeURIComponent` cannot encode. The two plugins only ever
 *   resolve ids and tags they were configured with; this guards a value an
 *   application sets through `replaceTenant` or `replaceLocale`.
 * - **the request lacks a tenant (or locale), but its URL already contains
 *   `setu-cache-tenant=` (or `setu-cache-locale=`).** Its key would be the
 *   URL itself, which is exactly a tenanted request's key
 *   (`/page?setu-cache-tenant=acme` is `/page` for `acme`). Every key for a
 *   request carrying the value contains the name, so a key for one that does
 *   not cannot match it. This arises only where an application resolves the
 *   tenant or locale on some requests and not others; both plugins' own
 *   middleware set theirs on every request they govern.
 *
 * With those excluded, a key is the parsed URL's own text plus, in a fixed
 * order, the encoded value of each discriminator the request carries — so the
 * names present in a key are exactly the ones the request resolved, and two
 * keys match only when the URL, the tenant and the locale all do.
 */
function defaultKey(ctx: IRequestContext): string | undefined {
  const url = ctx.request.url;
  if (url.includes('#') || !isParsedForm(url)) {
    return undefined;
  }
  let key = url;
  for (const { name, read } of KEY_DISCRIMINATORS) {
    const value = read(ctx);
    if (value === undefined) {
      if (url.includes(`${name}=`)) {
        return undefined;
      }
      continue;
    }
    const encoded = encodeValue(value);
    if (encoded === undefined) {
      return undefined;
    }
    key += `${key.includes('?') ? '&' : '?'}${name}=${encoded}`;
  }
  return key;
}

/**
 * Percent-encodes a discriminator value for the key, or `undefined` when it is
 * not well-formed UTF-16 (`encodeURIComponent` throws `URIError` on a lone
 * surrogate). A `try` rather than `String.prototype.isWellFormed`, which Node
 * 18 lacks.
 */
function encodeValue(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Reports whether `url` is exactly its own WHATWG serialization. */
function isParsedForm(url: string): boolean {
  // `new URL` + `try` rather than `URL.parse`, which is newer than some of the
  // runtimes this package supports.
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/**
 * Caches responses in the Cloudflare edge cache.
 *
 * On a hit the cached response is replayed and the handler chain is **not**
 * invoked. On a miss the handler runs and its response is stored in the
 * background through `ICloudflareBindings.waitUntil`, so the write never delays
 * the client.
 *
 * Skipped without error, each reported as `X-Cache-Api: BYPASS` or `MISS`:
 *
 * - `bypass` returned `true`;
 * - with the default key, the URL is not in its parsed form, carries a
 *   fragment, or a tenant id or locale is not well-formed, or the request
 *   lacks a tenant or locale while its URL contains `setu-cache-tenant=` or
 *   `setu-cache-locale=` — in each case no key could keep the request apart
 *   from another (this last one applies to an application without either
 *   plugin too);
 * - no cache handle is available (not running on Cloudflare Workers);
 * - the response is a live stream — teeing it would double the memory the
 *   stream exists to avoid and change its flush timing (the M42 guard
 *   `cache-plugin` also applies);
 * - `assessCacheability` found a refusal, so `put` would have thrown.
 *
 * Two platform properties are worth knowing before relying on this:
 * `caches.default` is **per-datacenter**, so it is a latency optimisation and
 * not a shared store; and it is scoped to the zone, so a key must be unique
 * across every route that caches.
 *
 * One testing note: a HIT is replayed with `IResponse.stream`, so a cached
 * response of any size reaches the client without being buffered — which means
 * `app.inject()` cannot read its body. Drive a cached route with `app.fetch`
 * and a web `Request`, which is what a Worker invokes anyway.
 *
 * @example
 * ```typescript
 * app.router.get('/catalog', {
 *   handler: listCatalog,
 *   middleware: [cacheApiMiddleware({ ttlSeconds: 300 })],
 * });
 * ```
 * @param options - Cache handle, key, bypass, cacheable statuses, and TTL
 * @returns The middleware function
 * @since 0.2.0
 */
export function cacheApiMiddleware(options?: CacheApiMiddlewareOptions): MiddlewareFunction {
  const keyFn = options?.key;
  const bypassFn = options?.bypass;
  const cacheableStatuses = options?.cacheableStatuses ?? DEFAULT_CACHEABLE_STATUSES;
  const ttlSeconds = options?.ttlSeconds;

  // Resolved once: the global does not change over a Worker's lifetime, and a
  // per-request probe would be work on the hot path (AI_GUIDELINES §14).
  const cache = options?.cache ?? resolveCacheApi();

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // The method is checked BEFORE the read, not only before the write. The
    // cache key is a URL string, which the Cache API resolves as a GET request,
    // so a POST to a path with a cached GET response would otherwise be served
    // that response and its handler would never run — a mutation silently
    // discarded behind a 200. Reachable whenever this sits on the global
    // pipeline rather than a single GET route.
    if (
      cache === undefined ||
      ctx.request.method !== 'GET' ||
      (bypassFn !== undefined && bypassFn(ctx))
    ) {
      await next();
      ctx.response.header(STATUS_HEADER, 'BYPASS');
      return;
    }

    const key = keyFn !== undefined ? keyFn(ctx) : defaultKey(ctx);
    if (key === undefined) {
      await next();
      ctx.response.header(STATUS_HEADER, 'BYPASS');
      return;
    }

    const hit = await cache.match(key);
    if (hit !== undefined) {
      replay(ctx.response, hit);
      // Short-circuit: next() is NOT called, so the handler cannot overwrite
      // the replayed response.
      return;
    }

    await next();

    const snapshot = ctx.response.snapshot();
    if (snapshot.streaming) {
      ctx.response.header(STATUS_HEADER, 'MISS');
      return;
    }

    const refusals = assessCacheability({
      method: ctx.request.method,
      status: snapshot.status,
      headers: snapshot.headers,
      cacheableStatuses,
    });

    if (refusals.length === 0) {
      const stored = buildStoredResponse(snapshot.status, snapshot.headers, snapshot.body, {
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      await store(ctx, cache, key, stored);
    }

    ctx.response.header(STATUS_HEADER, 'MISS');
  };
}

/** Copies a cached response onto the framework response and ends it. */
function replay(response: IResponse, cached: Response): void {
  response.status(cached.status);

  for (const [name, value] of cached.headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;

    // `Set-Cookie` is the one header a `Headers` iterator yields once PER
    // VALUE rather than comma-joined, so `header()` — which overwrites — would
    // keep only the last of several and silently drop the rest. Every other
    // repeated header arrives already combined, where overwriting is correct.
    if (name.toLowerCase() === 'set-cookie') {
      response.appendHeader(name, value);
    } else {
      response.header(name, value);
    }
  }
  response.header(STATUS_HEADER, 'HIT');

  // Streamed rather than buffered: the body is already a `ReadableStream` and
  // M42's `IResponse.stream` passes it through to the platform untouched, so a
  // large cached response never lands in memory.
  if (cached.body === null) {
    response.send();
    return;
  }
  response.stream(cached.body);
}

/** Builds the native `Response` handed to the cache. */
function buildStoredResponse(
  status: number,
  live: Headers,
  body: Uint8Array | string | null,
  options: { readonly ttlSeconds?: number },
): Response {
  // A copy, never the live instance: `snapshot().headers` IS the response's own
  // `Headers` (common/src/http.ts:176), so adding Cache-Control to it would put
  // the header on the client's response too.
  const headers = new Headers(live);

  if (options.ttlSeconds !== undefined && !headers.has('cache-control')) {
    headers.set('cache-control', `public, max-age=${options.ttlSeconds}`);
  }

  // `new Response(null)` is required for a status that forbids a body; passing
  // an empty string would throw for 204/304. Bytes are copied into a fresh
  // ArrayBuffer-backed view: `snapshot().body` may be backed by a
  // SharedArrayBuffer, which `BodyInit` does not accept, and the stored copy
  // outlives the request that produced it either way.
  const init: BodyInit | null = body === null
    ? null
    : (typeof body === 'string' ? body : new Uint8Array(body));

  return new Response(init, { status, headers });
}

/**
 * Writes to the cache off the response path when the plugin is registered.
 *
 * **A failed write never fails the request.** The response has already been
 * produced by the time this runs, and a cache is an accelerator: letting
 * `put`'s rejection propagate would turn a perfectly good 200 into the kernel's
 * 500. `Cache.put` rejects for real and reachable reasons — an oversized
 * response, or a quota error — so this is a live path, not a defensive one. Both
 * branches below report rather than throw, which also keeps them behaviourally
 * identical: with the plugin registered `waitUntil` already attaches that
 * reporting (background/wait-until.ts), and without it this does.
 *
 * `ctx.services.has` rather than a `try`/`catch` around `get`: the registry
 * throws on an unregistered token (common/src/registry.ts:96), and catching
 * would also swallow a genuine failure from the resolved service.
 */
async function store(
  ctx: IRequestContext,
  cache: ICacheApi,
  key: string,
  response: Response,
): Promise<void> {
  const put = cache.put(key, response);

  if (ctx.services.has(CAPABILITIES.CLOUDFLARE)) {
    ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE).waitUntil(put);
    return;
  }

  // No plugin to extend the invocation past the response: awaiting is the only
  // way the write is not simply abandoned when the isolate is released.
  try {
    await put;
  } catch (error: unknown) {
    reportWriteFailure(ctx, key, error);
  }
}

/** Reports a cache-write failure through the logger, when one is registered. */
function reportWriteFailure(ctx: IRequestContext, key: string, error: unknown): void {
  if (!ctx.services.has(CAPABILITIES.LOGGER)) return;

  ctx.services.get<ILogger>(CAPABILITIES.LOGGER).error(
    'cloudflare-cache-api: edge cache write failed, response served uncached',
    { key, error: error instanceof Error ? error.message : String(error) },
  );
}
