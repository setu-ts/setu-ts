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
import {
  cacheControlDirectives,
  CAPABILITIES,
  COOKIE_DEPENDENT_RESPONSE_STATE_KEY,
  parseCookie,
  PER_VISITOR_RESPONSE_STATE_KEY,
} from '@setu-ts/common';
import type { ICloudflareBindings } from '../bindings/binding-registry.ts';
import { isHostlessRegistry } from '../background/wait-until.ts';
import type { ICacheApi } from './cache-api.ts';
import { resolveCacheApi } from './cache-api.ts';
import { assessCacheability, isPrivate } from './cacheability.ts';
import { cacheApiKey } from './cache-api-key.ts';

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
   * Adds `Cache-Control: max-age=<n>` to the **stored copy** when the response
   * carries no `Cache-Control` of its own. The edge honors the stored
   * response's own directive, so without one an entry has no freshness lifetime
   * and is of little use. The client's response is left untouched. Not
   * `public`: the stored copy must not read as shareable with a request that
   * carries credentials unless the origin itself said `public`.
   */
  readonly ttlSeconds?: number;
  /**
   * The cookies that make a request **credentialed**. Omitted, any cookie
   * does; `[]` leaves `Authorization` as the only credential. A credentialed
   * request is served only a stored response that says `public` and whose
   * `Vary` names neither `Cookie` nor `Authorization`, and its own response is
   * stored only on the same terms. A request carrying any cookie at all, named
   * here or not, is never served an entry that varies on `Cookie` or
   * `Authorization`. The same rule, and the same option, as `cache-plugin`'s
   * `cacheMiddleware`.
   * @since 0.14.0
   */
  readonly credentialCookies?: readonly string[];
}

/** The default key: the request URL plus its resolved tenant and locale. */
function defaultKey(ctx: IRequestContext): string | undefined {
  const tenant = ctx.request.tenant?.id;
  const locale = ctx.request.locale;
  return cacheApiKey({
    url: ctx.request.url,
    ...(tenant === undefined ? {} : { tenant }),
    ...(locale === undefined ? {} : { locale }),
  });
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
 * - the request is not a `GET` — the key is a URL string the Cache API resolves
 *   as a GET, so a `POST` could otherwise be answered from a cached `GET`;
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
  const credentialCookies = options?.credentialCookies;
  // Once per middleware instance (so once per isolate on Workers), and only
  // when a logger heard it.
  let privateSetCookieWarned = false;

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

    // The key is the URL, so `Vary` cannot keep a per-visitor entry apart:
    // the rule holds on the lookup side as well as the store side.
    const credentialed = isCredentialed(ctx.request.headers, credentialCookies);
    const withCookies = credentialed || carriesCookie(ctx.request.headers);

    const hit = await cache.match(key);
    if (hit !== undefined) {
      if (!withCookies || servableWithCookies(hit.headers, credentialed)) {
        replay(ctx.response, hit);
        // Short-circuit: next() is NOT called, so the handler cannot overwrite
        // the replayed response.
        return;
      }
      // Not this request's to see; the entry stays for the requests it suits.
      void hit.body?.cancel().catch(() => {});
    }

    await next();

    const snapshot = ctx.response.snapshot();
    if (snapshot.streaming) {
      ctx.response.header(STATUS_HEADER, 'MISS');
      return;
    }

    // A response a component flagged as depending on cookies is judged and
    // stored as varying on `Cookie`, whatever its own `Vary` says.
    const headers =
      ctx.state.get(COOKIE_DEPENDENT_RESPONSE_STATE_KEY) === true
        ? withVaryCookie(snapshot.headers)
        : snapshot.headers;
    const refusals = assessCacheability({
      method: ctx.request.method,
      status: snapshot.status,
      headers,
      cacheableStatuses,
    });

    if (
      refusals.length === 0 &&
      ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY) !== true &&
      (!withCookies || servableWithCookies(headers, credentialed))
    ) {
      const stored = buildStoredResponse(snapshot.status, headers, snapshot.body, {
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      await store(ctx, cache, key, stored);
    } else if (
      !privateSetCookieWarned &&
      refusals.includes('private') &&
      namesSetCookieInPrivate(headers.get('cache-control')) &&
      ctx.services.has(CAPABILITIES.LOGGER)
    ) {
      privateSetCookieWarned = true;
      ctx.services
        .get<ILogger>(CAPABILITIES.LOGGER)
        .warn(
          'cloudflare-cache-api: Cache-Control: private=Set-Cookie is not stored in the edge ' +
            'cache; any private directive refuses it, as cacheMiddleware does. Drop Set-Cookie ' +
            'from cacheable responses instead',
          { path: ctx.request.path },
        );
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
    headers.set('cache-control', `max-age=${options.ttlSeconds}`);
  }

  // `new Response(null)` is required for a status that forbids a body; passing
  // an empty string would throw for 204/304. Bytes are copied into a fresh
  // ArrayBuffer-backed view: `snapshot().body` may be backed by a
  // SharedArrayBuffer, which `BodyInit` does not accept, and the stored copy
  // outlives the request that produced it either way.
  const init: BodyInit | null =
    body === null ? null : typeof body === 'string' ? body : new Uint8Array(body);

  return new Response(init, { status, headers });
}

/**
 * Writes to the cache off the response path when the plugin is registered.
 *
 * **A failed write never fails the request.** The response has already been
 * produced by the time this runs, and a cache is an accelerator: letting
 * `put`'s rejection propagate would turn a perfectly good 200 into the kernel's
 * 500. `Cache.put` rejects for real and reachable reasons — an oversized
 * response, or a quota error — so this is a live path, not a defensive one.
 *
 * Every branch reports through {@linkcode reportWriteFailure} before the write
 * is awaited or handed on, so a cache rejection never reaches the generic
 * `waitUntil` reporter, which logs its message (M113d §10, F1). A host gets a
 * promise that already settles quietly. A `put` that throws synchronously is
 * reported the same way and nothing is handed on.
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
  let written: Promise<void>;
  try {
    written = cache.put(key, response).catch((error: unknown) => {
      reportWriteFailure(ctx, error);
    });
  } catch (error) {
    // A custom cache may throw from `put` instead of rejecting; that is the
    // same failed write, reported once and never surfaced to the request.
    reportWriteFailure(ctx, error);
    return;
  }

  if (ctx.services.has(CAPABILITIES.CLOUDFLARE)) {
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    // A hostless registry's sink delegates to nothing (M113d §3.6): handing
    // the write to it abandons the write when the isolate is released, so it
    // is awaited exactly as the no-plugin branch below does. A replacement
    // provider's bindings are not in the hostless set and are trusted.
    if (!isHostlessRegistry(bindings)) {
      bindings.waitUntil(written);
      return;
    }
  }

  // No sink to extend the invocation past the response: awaiting is the only
  // way the write is not simply abandoned when the isolate is released.
  await written;
}

/**
 * Reports a cache-write failure through the logger, when one is registered.
 *
 * The record names the request PATH, never the cache key (M113d §10, D1). The
 * default key is the full URL with its query string plus the tenant id and
 * locale, and a custom `key` function may build any string; a query string can
 * carry a credential and a tenant id identifies a customer, so neither belongs
 * in a log an operator reads to learn which route failed.
 *
 * The error is logged by CLASS, not message (M113d §10, F1): a custom
 * {@linkcode ICacheApi} may quote the key it was given in its rejection, which
 * would carry the same query string and tenant id back into the record.
 */
function reportWriteFailure(ctx: IRequestContext, error: unknown): void {
  if (!ctx.services.has(CAPABILITIES.LOGGER)) return;

  ctx.services
    .get<ILogger>(CAPABILITIES.LOGGER)
    .error('cloudflare-cache-api: edge cache write failed, response served uncached', {
      path: ctx.request.path,
      error: error instanceof Error ? error.name : typeof error,
    });
}

/**
 * Whether a request carries a credential: `Authorization`, or a cookie that
 * counts (any cookie when `credentialCookies` is omitted).
 */
function isCredentialed(
  headers: Headers,
  credentialCookies: readonly string[] | undefined,
): boolean {
  if (headers.has('authorization')) return true;
  if (credentialCookies === undefined) return carriesCookie(headers);
  const cookies = parseCookie(headers.get('cookie'));
  return credentialCookies.some((name) => Object.hasOwn(cookies, name));
}

/** Whether a request carries any non-blank `Cookie` header, a nameless pair included. */
function carriesCookie(headers: Headers): boolean {
  return (headers.get('cookie') ?? '').trim() !== '';
}

/** The lowercased field names of a `Vary` value. */
function varyFields(vary: string | null): string[] {
  return vary === null ? [] : vary.split(',').map((field) => field.trim().toLowerCase());
}

/** A copy of `headers` whose `Vary` names `Cookie`, added once. */
function withVaryCookie(headers: Headers): Headers {
  const copy = new Headers(headers);
  if (!varyFields(copy.get('vary')).includes('cookie')) copy.append('vary', 'Cookie');
  return copy;
}

/**
 * Whether a response, live or stored, may be served to (or stored from) a
 * request carrying a cookie or `Authorization`: its `Vary` names neither, and,
 * for a credentialed request, it says `public` and is not private.
 */
function servableWithCookies(headers: Headers, credentialed: boolean): boolean {
  if (varyFields(headers.get('vary')).some((f) => f === 'cookie' || f === 'authorization')) {
    return false;
  }
  if (!credentialed) return true;
  const cacheControl = headers.get('cache-control');
  return cacheControl !== null && !isPrivate(cacheControl) && hasPublic(cacheControl);
}

/** Whether a readable `Cache-Control` value holds `public`, by the shared parser. */
function hasPublic(cacheControl: string): boolean {
  return cacheControlDirectives(cacheControl)?.includes('public') ?? false;
}

/**
 * Whether `Cache-Control` names `Set-Cookie` in `private`'s field list, in the
 * token form (`private=Set-Cookie`) or the quoted-list form
 * (`private="X-A, Set-Cookie"`), case-insensitively. `false` for an unreadable
 * value or a `set-cookie` inside another directive's argument.
 */
export function namesSetCookieInPrivate(cacheControl: string | null): boolean {
  if (cacheControl === null) return false;
  const directives = splitDirectives(cacheControl);
  if (directives === undefined) return false;
  return directives.some((directive) => {
    const eq = directive.indexOf('=');
    if (eq < 0 || directiveName(directive) !== 'private') return false;
    let value = directive.slice(eq + 1).trim();
    if (value.startsWith('"')) value = value.slice(1, -1);
    return value
      .split(',')
      .map((field) => field.trim().toLowerCase())
      .includes('set-cookie');
  });
}

/** A directive's lowercased name. */
function directiveName(directive: string): string {
  const eq = directive.indexOf('=');
  return (eq < 0 ? directive : directive.slice(0, eq)).trim().toLowerCase();
}

/**
 * Splits `Cache-Control` into its directives on commas outside quotes;
 * `undefined` for an unclosed quote.
 */
function splitDirectives(cacheControl: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < cacheControl.length; i++) {
    const char = cacheControl[i] as string;
    if (quoted && char === '\\') {
      current += char + (cacheControl[i + 1] ?? '');
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted) return undefined;
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}
