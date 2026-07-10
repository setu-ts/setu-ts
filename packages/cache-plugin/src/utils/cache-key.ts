/**
 * Cache key generation utilities.
 *
 * Extracted as an internal seam so key-generation branching can be unit-
 * tested directly without a full request pipeline.
 *
 * @module
 */
import type { IRequestContext } from '@hono-enterprise/common';

/**
 * Default cache key: `${request.method}:${request.url}`.
 *
 * The URL includes query parameters, so the key varies by query string.
 *
 * @param ctx - The request context
 * @returns The cache key string
 * @example
 * ```typescript
 * defaultCacheKey(ctx); // "GET:http://localhost/api/users?page=1"
 * ```
 */
export function defaultCacheKey(ctx: IRequestContext): string {
  return `${ctx.request.method}:${ctx.request.url}`;
}
