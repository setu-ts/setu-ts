/**
 * Transparent response-caching middleware.
 *
 * Resolves an {@linkcode ICacheStore} at request time, reads a cached
 * response on HIT (short-circuiting the handler chain), or captures the
 * handler's response on MISS and stores it when the status is cacheable.
 *
 * @module
 */
import type { ICacheStore, IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { CachedResponsePayload, CacheMiddlewareOptions } from '../interfaces/index.ts';
import { defaultCacheKey } from '../utils/cache-key.ts';
import { decodePayload, encodePayload } from '../utils/cache-payload.ts';

/**
 * Hop-by-hop headers that must NOT be cached or replayed. Per RFC 7230/7231
 * these are connection-specific and meaningless outside the original request.
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
 * Create a caching middleware function.
 *
 * All options are optional — the middleware reads them defensively and falls
 * back to sensible defaults.
 *
 * @param options - Optional middleware configuration
 * @returns The middleware function
 * @since 0.1.0
 */
export function cacheMiddleware(
  options?: CacheMiddlewareOptions,
): MiddlewareFunction {
  const ttlSeconds = options?.ttlSeconds;
  const keyFn = options?.key;
  const bypassFn = options?.bypass;
  const storeToken = options?.store ?? CAPABILITIES.CACHE;
  const cacheableStatuses = options?.cacheableStatuses ?? [200];

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Bypass: skip cache entirely.
    if (bypassFn !== undefined && bypassFn(ctx)) {
      await next();
      return;
    }

    const key = keyFn !== undefined ? keyFn(ctx) : defaultCacheKey(ctx);

    // Resolve store at request time (not middleware-creation time).
    const store = ctx.services.get<ICacheStore>(storeToken);

    // Try to read a cached HIT.
    const cached = await store.get<CachedResponsePayload>(key);

    if (cached !== null) {
      // HIT — replay cached response and short-circuit.
      const decoded = decodePayload(cached);

      // Set status.
      ctx.response.status(decoded.status);

      // Copy headers, stripping hop-by-hop.
      for (const [name, value] of decoded.headers) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          ctx.response.header(name, value);
        }
      }

      // Mark as cache HIT.
      ctx.response.header('X-Cache', 'HIT');

      // Replay body preserving type so the kernel transport can surface it.
      // String bodies must use text() — the kernel's inject() only surfaces
      // STRING bodies (see application.ts:387). After text() sets
      // text/plain, re-assert the cached content-type header so the correct
      // type is returned.
      if (decoded.bodyBytes instanceof Uint8Array) {
        // Binary payload (base64-encoded in cache). send(bytes) is correct.
        // For binary, inject().body === null is an inherent inject limitation
        // until M39 HTTP adapters; acceptable.
        ctx.response.send(decoded.bodyBytes);
      } else if (typeof decoded.bodyBytes === 'string') {
        // String payload — use text() so snapshot.body is a string.
        ctx.response.text(decoded.bodyBytes);
        // text() sets text/plain; re-assert the cached content-type.
        const cachedCT = decoded.headers.find(
          ([name]) => name.toLowerCase() === 'content-type',
        );
        if (cachedCT !== undefined) {
          ctx.response.header('content-type', cachedCT[1]);
        }
      } else {
        // Null/empty body — call a terminal method so the response is ended.
        ctx.response.send();
      }

      // Short-circuit — do NOT call next().
      return;
    }

    // MISS — invoke handler chain.
    await next();

    // Read the response snapshot after the handler wrote to ctx.response.
    const snapshot = ctx.response.snapshot();

    // M42 streaming guard: a live stream is not cacheable and must not be
    // drained by an observer. Because snapshot() is a discriminated union,
    // this branch narrows snapshot to the `streaming: false` arm for the
    // rest of the function, so encodePayload(type-checks against its
    // `body: Uint8Array | string | null` parameter with no cast.
    if (snapshot.streaming) {
      ctx.response.header('X-Cache', 'MISS');
      return;
    }

    // Store only if cacheable and no Set-Cookie.
    if (
      cacheableStatuses.includes(snapshot.status) &&
      !hasSetCookie(snapshot.headers)
    ) {
      const payload = encodePayload(snapshot);
      await store.set<CachedResponsePayload>(key, payload, ttlSeconds);
    }

    // Mark as cache MISS.
    ctx.response.header('X-Cache', 'MISS');
  };
}

/**
 * Check whether a `Headers` object carries any `Set-Cookie` header.
 *
 * @param headers - The response headers
 * @returns `true` if Set-Cookie is present (including multiple values)
 */
function hasSetCookie(headers: Headers): boolean {
  return headers.has('set-cookie');
}
