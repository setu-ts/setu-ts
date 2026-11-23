/**
 * The Cache API's refusal rules, evaluated before a write is attempted.
 *
 * `caches.default.put` **throws** for a non-GET request, a 206 response, a
 * `Vary: *` response, and a response carrying `Set-Cookie`. The platform's
 * `Cache-Control: private=Set-Cookie` escape hatch is not used: any `private`
 * marks a response as one visitor's, and it is refused (`'private'`), the
 * same rule `cache-plugin`'s `cacheMiddleware` applies. Discovering
 * those by letting `put` reject inside a `waitUntil`-ed background task turns
 * an ordinary uncacheable response into a logged failure on every request;
 * checking first turns it into a documented skip.
 *
 * @module
 */

import { cacheControlDirectives } from '@setu-ts/common';

/**
 * Why the edge cache would refuse a response.
 *
 * @since 0.2.0
 */
export type CacheRefusal =
  /** The request method is not GET; the Cache API caches GET only. */
  | 'method'
  /** The status is outside the configured cacheable set. */
  | 'status'
  /** The status is 206; the platform refuses partial content unconditionally. */
  | 'partial-content'
  /** The response carries `Vary: *`, which the platform refuses. */
  | 'vary-star'
  /** The response carries `Set-Cookie`. */
  | 'set-cookie'
  /**
   * `Cache-Control` holds `private` (qualified or not) or `no-store`, or cannot
   * be read (an unclosed quote): the response belongs to one visitor.
   * @since 0.14.0
   */
  | 'private';

/** What {@linkcode assessCacheability} needs to decide. */
export interface CacheabilityInput {
  /** The request method. */
  readonly method: string;
  /** The response status. */
  readonly status: number;
  /** The response headers. */
  readonly headers: Headers;
  /** Statuses the caller considers cacheable. */
  readonly cacheableStatuses: readonly number[];
}

/** HTTP 206 — refused by the platform whatever the caller configured. */
const PARTIAL_CONTENT = 206;

/**
 * Lists every reason the edge cache would refuse this response.
 *
 * Exported because it is the one honest way to ask "would the edge cache
 * this?" without attempting a write and catching the rejection.
 *
 * The 206 and `Vary: *` checks are **unconditional**, evaluated independently
 * of `cacheableStatuses`: an operator can legitimately configure
 * `[200, 206]`, at which point the status check passes and only the explicit
 * 206 rule stops the platform from throwing.
 *
 * @param input - The request method, response status, headers, and the
 * caller's cacheable-status set
 * @returns Every refusal that applies; empty when the response is cacheable
 * @example
 * ```typescript
 * const refusals = assessCacheability({
 *   method: 'GET',
 *   status: 200,
 *   headers: new Headers({ 'set-cookie': 'a=1' }),
 *   cacheableStatuses: [200],
 * });
 * // → ['set-cookie']
 * ```
 * @since 0.2.0
 */
export function assessCacheability(input: CacheabilityInput): readonly CacheRefusal[] {
  const refusals: CacheRefusal[] = [];

  if (input.method.toUpperCase() !== 'GET') refusals.push('method');
  if (!input.cacheableStatuses.includes(input.status)) refusals.push('status');
  if (input.status === PARTIAL_CONTENT) refusals.push('partial-content');
  if (varyIsStar(input.headers)) refusals.push('vary-star');
  if (input.headers.has('set-cookie')) refusals.push('set-cookie');
  if (isPrivate(input.headers.get('cache-control'))) refusals.push('private');

  return refusals;
}

/**
 * Reports whether `Vary` is the wildcard.
 *
 * A `Vary` listing real field names is fine; only `*` is refused. The header
 * can carry several comma-separated values, so a bare equality check would miss
 * `Vary: Accept, *`.
 */
function varyIsStar(headers: Headers): boolean {
  const vary = headers.get('vary');
  if (vary === null) return false;
  return vary.split(',').some((value) => value.trim() === '*');
}

/**
 * Whether a `Cache-Control` value marks the response as one visitor's:
 * `private` (with or without a field list) or `no-store`, read quote-aware;
 * an unreadable value (an unclosed quote) counts, failing safe. The same rule
 * as `cache-plugin`'s `cacheMiddleware`.
 */
export function isPrivate(cacheControl: string | null): boolean {
  if (cacheControl === null) return false;
  const directives = cacheControlDirectives(cacheControl);
  if (directives === undefined) return true;
  return directives.includes('private') || directives.includes('no-store');
}
