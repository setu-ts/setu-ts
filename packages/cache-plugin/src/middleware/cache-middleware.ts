/**
 * Transparent response-caching middleware.
 *
 * Resolves an {@linkcode ICacheStore} at request time, reads a cached
 * response on HIT (short-circuiting the handler chain), or captures the
 * handler's response on MISS and stores it when the status is cacheable.
 *
 * It never stores a per-visitor response. A response whose `Cache-Control`
 * says `private` or `no-store` is not stored. A request carrying
 * `Authorization` or a credential cookie (any cookie by default, see
 * {@linkcode CacheMiddlewareOptions.credentialCookies}) is credentialed: it is
 * served a HIT only from a `public` entry whose `Vary` names neither `Cookie`
 * nor `Authorization`, never shares an origin run with another request, and
 * its own response is stored only when it says `public` and its `Vary` names
 * neither. A response that varies on `Cookie` is stored only from a request
 * that carries no credential, so it is only ever the cookie-less variant.
 *
 * @module
 */
import type { ICacheStore, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES, parseCookie } from '@setu-ts/common';
import type { CachedResponsePayload, CacheMiddlewareOptions } from '../interfaces/index.ts';
import { cacheCoalescer } from '../services/coalescer.ts';
import { composeCacheKey } from '../utils/cache-key.ts';
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

/** Result of one origin execution as observed by cache middleware. */
type CacheOriginOutcome =
  | {
      readonly replayable: true;
      readonly payload: CachedResponsePayload;
    }
  | {
      readonly replayable: false;
    };

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
export function cacheMiddleware(options?: CacheMiddlewareOptions): MiddlewareFunction {
  const ttlSeconds = options?.ttlSeconds;
  const keyFn = options?.key;
  const varyFn = options?.vary;
  const bypassFn = options?.bypass;
  const storeToken = options?.store ?? CAPABILITIES.CACHE;
  const cacheableStatuses = options?.cacheableStatuses ?? [200];
  const credentialCookies = options?.credentialCookies;

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Bypass: skip cache entirely.
    if (bypassFn !== undefined && bypassFn(ctx)) {
      await next();
      return;
    }

    // The tenant and vary segments are composed around the base key (custom
    // `key` or default), so a tenant-aware application stores one entry per
    // tenant even when the caller supplies its own key function.
    const baseKey = keyFn !== undefined ? keyFn(ctx) : undefined;
    const key = composeCacheKey(ctx, baseKey, varyFn);

    // Resolve store at request time (not middleware-creation time).
    const store = ctx.services.get<ICacheStore>(storeToken);

    // A credentialed request may see a per-visitor response: it is served
    // only a `public` entry that does not vary on a credential, runs its own
    // origin outside the coalescer, and stores its response only when that
    // response says `public` and does not vary on a credential.
    if (isCredentialed(ctx.request.headers, credentialCookies)) {
      const entry = await store.get<CachedResponsePayload>(key);
      if (entry !== null && sharedWithCredentialed(entry)) {
        replayCachedResponse(ctx, entry, 'HIT');
        return;
      }
      await captureOrigin(ctx, next, store, key, ttlSeconds, cacheableStatuses, true);
      ctx.response.header('X-Cache', 'MISS');
      return;
    }

    // Try to read a cached HIT.
    const cached = await store.get<CachedResponsePayload>(key);

    if (cached !== null) {
      replayCachedResponse(ctx, cached, 'HIT');
      return;
    }

    const coalesced = await cacheCoalescer.run(
      store,
      key,
      async (): Promise<CacheOriginOutcome> => {
        return await captureOrigin(ctx, next, store, key, ttlSeconds, cacheableStatuses);
      },
    );

    if (!coalesced.ok) {
      if (!coalesced.joined) {
        throw coalesced.error;
      }
      await captureOrigin(ctx, next, store, key, ttlSeconds, cacheableStatuses);
      ctx.response.header('X-Cache', 'MISS');
      return;
    }

    if (coalesced.joined) {
      if (coalesced.value.replayable) {
        replayCachedResponse(ctx, coalesced.value.payload, 'COALESCED');
        return;
      }
      // A streaming, non-cacheable, or Set-Cookie leader cannot be replayed.
      // This request gets its own origin execution, as it did before coalescing.
      await captureOrigin(ctx, next, store, key, ttlSeconds, cacheableStatuses);
    }

    ctx.response.header('X-Cache', 'MISS');
  };
}

/**
 * Runs the route chain and captures a replayable response only when safe.
 */
async function captureOrigin(
  ctx: IRequestContext,
  next: () => Promise<void>,
  store: ICacheStore,
  key: string,
  ttlSeconds: number | undefined,
  cacheableStatuses: readonly number[],
  credentialed = false,
): Promise<CacheOriginOutcome> {
  await next();
  const snapshot = ctx.response.snapshot();
  if (
    snapshot.streaming ||
    !cacheableStatuses.includes(snapshot.status) ||
    hasSetCookie(snapshot.headers) ||
    isPrivate(snapshot.headers.get('cache-control')) ||
    (credentialed && !sharedWithCredentialed(snapshot.headers))
  ) {
    return { replayable: false };
  }

  const payload = encodePayload(snapshot);
  await store.set<CachedResponsePayload>(key, payload, ttlSeconds);
  return { replayable: true, payload };
}

/**
 * Applies one cached response to the current request context.
 */
function replayCachedResponse(
  ctx: IRequestContext,
  payload: CachedResponsePayload,
  cacheStatus: 'HIT' | 'COALESCED',
): void {
  const decoded = decodePayload(payload);
  ctx.response.status(decoded.status);
  for (const [name, value] of decoded.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      ctx.response.header(name, value);
    }
  }
  ctx.response.header('X-Cache', cacheStatus);

  if (decoded.bodyBytes instanceof Uint8Array) {
    ctx.response.send(decoded.bodyBytes);
  } else if (typeof decoded.bodyBytes === 'string') {
    ctx.response.text(decoded.bodyBytes);
    const cachedCT = decoded.headers.find(([name]) => name.toLowerCase() === 'content-type');
    if (cachedCT !== undefined) {
      ctx.response.header('content-type', cachedCT[1]);
    }
  } else {
    ctx.response.send();
  }
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

/**
 * Whether a request carries a credential: `Authorization`, or a cookie that
 * counts — any cookie when `credentialCookies` is omitted, only the named ones
 * otherwise (`[]` leaves `Authorization` alone).
 */
function isCredentialed(
  headers: Headers,
  credentialCookies: readonly string[] | undefined,
): boolean {
  if (headers.has('authorization')) {
    return true;
  }
  const cookies = parseCookie(headers.get('cookie'));
  if (credentialCookies === undefined) {
    return Object.keys(cookies).length > 0;
  }
  return credentialCookies.some((name) => Object.hasOwn(cookies, name));
}

/** Whether a `Cache-Control` value holds `private` or `no-store`. */
function isPrivate(cacheControl: string | null): boolean {
  return hasDirective(cacheControl, 'private') || hasDirective(cacheControl, 'no-store');
}

/**
 * Whether a response, live or stored, may be served to a credentialed request:
 * it says `public` and its `Vary` names neither `Cookie` nor `Authorization`.
 */
function sharedWithCredentialed(source: Headers | CachedResponsePayload): boolean {
  const read = (name: string): string | null => {
    if (source instanceof Headers) {
      return source.get(name);
    }
    const entry = source.headers.find(([header]) => header.toLowerCase() === name);
    return entry === undefined ? null : entry[1];
  };
  const cacheControl = read('cache-control');
  if (!hasDirective(cacheControl, 'public') || isPrivate(cacheControl)) {
    return false;
  }
  const vary = read('vary');
  return (
    vary === null ||
    !vary
      .split(',')
      .map((field) => field.trim().toLowerCase())
      .some((field) => field === 'cookie' || field === 'authorization' || field === '*')
  );
}

/**
 * Whether a `Cache-Control` value holds a directive, by name and case
 * insensitively (`private="set-cookie"` holds `private`).
 */
function hasDirective(cacheControl: string | null, directive: string): boolean {
  if (cacheControl === null) {
    return false;
  }
  return cacheControl.split(',').some((part) => {
    const name = part.split('=')[0]!.trim().toLowerCase();
    return name === directive;
  });
}
