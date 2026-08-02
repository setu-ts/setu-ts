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

import type { IRequestContext, IResponse, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
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
   * which is what the platform's own cache keys on.
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
 * app.router.get('/catalog', listCatalog, {
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
    if (cache === undefined || (bypassFn !== undefined && bypassFn(ctx))) {
      await next();
      ctx.response.header(STATUS_HEADER, 'BYPASS');
      return;
    }

    const key = keyFn !== undefined ? keyFn(ctx) : ctx.request.url;

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
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
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
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    // waitUntil already attaches rejection reporting (background/wait-until.ts),
    // so a failed write is logged rather than becoming an unhandled rejection.
    bindings.waitUntil(put);
    return;
  }

  // No plugin to extend the invocation past the response: awaiting is the only
  // way the write is not simply abandoned when the isolate is released.
  await put;
}
