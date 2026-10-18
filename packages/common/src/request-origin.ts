/** Public request origins shared by proxy-aware consumers. @module */
import type { IRequestContext } from './http.ts';
import { REQUEST_ORIGIN_STATE_KEY } from './state-keys.ts';

/** The public HTTP origin resolved for a request. @since 0.10.0 */
export type RequestOrigin = {
  /** Public HTTP scheme, without the colon. */
  readonly protocol: 'http' | 'https';
  /** Public hostname and optional port. */
  readonly host: string;
  /** Scheme and authority, with no trailing slash. */
  readonly origin: string;
};

/**
 * Reads the origin published by IP security, falling back to the request URL.
 * This accessor makes no proxy trust decision.
 * @param ctx - The current request context
 * @returns The published or URL-derived origin
 * @throws {TypeError} When the fallback request URL is invalid
 * @example
 * ```typescript
 * const origin = requestOriginOf(ctx).origin;
 * ```
 * @since 0.10.0
 */
export function requestOriginOf(ctx: IRequestContext): RequestOrigin {
  const published = ctx.state.get(REQUEST_ORIGIN_STATE_KEY) as
    Pick<RequestOrigin, 'protocol' | 'host'> | undefined;
  if (published !== undefined) {
    return { ...published, origin: `${published.protocol}://${published.host}` };
  }
  const url = new URL(ctx.request.url);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return { protocol, host: url.host, origin: `${protocol}://${url.host}` };
}

/**
 * Substitutes the published origin while preserving the request path and query.
 * Without a published origin, returns the original URL byte for byte.
 * @param ctx - The current request context
 * @returns The public absolute request URL
 * @throws {TypeError} When a URL requiring substitution is invalid
 * @example
 * ```typescript
 * const request = new Request(publicRequestUrl(ctx));
 * ```
 * @since 0.10.0
 */
export function publicRequestUrl(ctx: IRequestContext): string {
  if (!ctx.state.has(REQUEST_ORIGIN_STATE_KEY)) return ctx.request.url;
  const url = new URL(ctx.request.url);
  const origin = requestOriginOf(ctx);
  return `${origin.origin}${url.pathname}${url.search}${url.hash}`;
}
