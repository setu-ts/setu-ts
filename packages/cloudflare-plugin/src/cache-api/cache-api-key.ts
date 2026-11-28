/**
 * The edge-cache key text `cacheApiMiddleware` stores under, and eviction by
 * that key.
 *
 * @module
 * @since 0.14.0
 */

import type { ICacheApi } from './cache-api.ts';
import { resolveCacheApi } from './cache-api.ts';

/**
 * What {@linkcode cacheApiKey} builds a key from.
 * @since 0.14.0
 */
export interface CacheApiKeyInput {
  /** The request URL, as the handler sees it. */
  readonly url: string;
  /** The resolved tenant id (`ctx.request.tenant?.id`), if any. */
  readonly tenant?: string;
  /** The resolved locale (`ctx.request.locale`), if any. */
  readonly locale?: string;
}

/**
 * What {@linkcode purgeCacheApi} evicts.
 * @since 0.14.0
 */
export interface PurgeCacheApiTarget {
  /** The URL whose entries are evicted. */
  readonly url: string;
  /** The tenant id the entries were stored for, if any. */
  readonly tenant?: string;
  /**
   * The locales to evict. Omitted, only the entry stored with no locale is
   * evicted; list every locale the URL was served in to evict them all.
   */
  readonly locales?: readonly string[];
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
  readonly read: (input: CacheApiKeyInput) => string | undefined;
}[] = [
  { name: 'setu-cache-tenant', read: (input) => input.tenant },
  { name: 'setu-cache-locale', read: (input) => input.locale },
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
 *
 * Exported so an application can name, and evict, exactly the entry the
 * middleware stored (see {@linkcode purgeCacheApi}); the middleware's default
 * key calls this function.
 *
 * @param input - The request URL, and the resolved tenant id and locale, if any
 * @returns The key, or `undefined` when no key can keep the request apart
 * @example
 * ```typescript
 * cacheApiKey({ url: 'https://shop.example/catalog', locale: 'de' });
 * // → 'https://shop.example/catalog?setu-cache-locale=de'
 * ```
 * @since 0.14.0
 */
export function cacheApiKey(input: CacheApiKeyInput): string | undefined {
  const url = input.url;
  if (url.includes('#') || !isParsedForm(url)) {
    return undefined;
  }
  let key = url;
  for (const { name, read } of KEY_DISCRIMINATORS) {
    const value = read(input);
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
 * Evicts the entries `cacheApiMiddleware`'s default key stored for a URL, so
 * a write can be followed by fresh reads.
 *
 * **Local data center only:** `cache.delete` "only purges content of the
 * cache in the data center that the Worker was invoked", as Cloudflare
 * documents; other locations keep their copy until it expires. An application
 * whose middleware uses a custom `key` deletes with its own key instead.
 *
 * @param target - The URL, its tenant, and the locales to evict
 * @param options - `cache` overrides `caches.default` (as the middleware's own
 *   option does)
 * @returns How many entries were deleted; `0` off Cloudflare Workers
 * @example
 * ```typescript
 * app.router.post('/catalog', {
 *   handler: async (ctx) => {
 *     // ... persist the write ...
 *     await purgeCacheApi({ url: new URL('/catalog', ctx.request.url).href, locales: ['en', 'de'] });
 *     return ctx.response.status(204).send();
 *   },
 * });
 * ```
 * @since 0.14.0
 */
export async function purgeCacheApi(
  target: PurgeCacheApiTarget,
  options?: { readonly cache?: ICacheApi },
): Promise<number> {
  const cache = options?.cache ?? resolveCacheApi();
  if (cache === undefined) return 0;
  const locales: readonly (string | undefined)[] = target.locales ?? [undefined];
  let deleted = 0;
  for (const locale of locales) {
    const key = cacheApiKey({
      url: target.url,
      ...(target.tenant === undefined ? {} : { tenant: target.tenant }),
      ...(locale === undefined ? {} : { locale }),
    });
    if (key !== undefined && (await cache.delete(key))) deleted++;
  }
  return deleted;
}
