/**
 * Cache key generation utilities.
 *
 * Extracted as an internal seam so key-generation branching can be unit-
 * tested directly without a full request pipeline.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

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

/**
 * The tenant discriminator segment, length-prefixed so the boundary is
 * unambiguous for any tenant id.
 *
 * Reads `ctx.request.tenant?.id` — the field the multi-tenancy middleware
 * writes — and is the empty string when no tenant is resolved, so an
 * application without tenancy keeps byte-identical keys. The length prefix
 * (`t:<len>:<id>|`) is load-bearing: tenant ids arrive from a header,
 * subdomain, path segment, or JWT claim, so at least one resolver puts
 * caller-influenced text into the key, and a bare `acme|GET:/x` join would be
 * forgeable by a tenant literally named `acme|GET:/x`.
 *
 * @param ctx - The request context
 * @returns `t:<len>:<id>|` when a tenant is resolved, `''` otherwise
 */
export function tenantSegment(ctx: IRequestContext): string {
  const id = ctx.request.tenant?.id;
  if (id === undefined) {
    return '';
  }
  return `t:${id.length}:${id}|`;
}

/**
 * The per-request `vary` discriminator segment, each value length-prefixed.
 *
 * Omitted (no `vary` function) yields the empty string, leaving the key
 * unchanged. Each supplied value is encoded as `v:<len>:<value>|` so a value
 * containing a separator cannot be mistaken for a boundary, mirroring the
 * tenant segment's forgery resistance.
 *
 * @param ctx - The request context
 * @param vary - Optional discriminator function; `undefined` yields `''`
 * @returns The concatenated vary segment, or `''`
 */
export function varySegment(
  ctx: IRequestContext,
  vary?: (ctx: IRequestContext) => readonly string[],
): string {
  if (vary === undefined) {
    return '';
  }
  let segment = '';
  for (const value of vary(ctx)) {
    segment += `v:${value.length}:${value}|`;
  }
  return segment;
}

/**
 * Composes the full cache key as `tenantSegment + varySegment + baseKey`.
 *
 * `baseKey` is the caller's `key` function's output when supplied and
 * `defaultCacheKey` otherwise. The tenant and vary segments are applied
 * around a custom key too, not only around the default — a caller who
 * supplies `key` in a tenant application would otherwise reproduce the
 * cross-tenant disclosure this exists to prevent.
 *
 * @param ctx - The request context
 * @param baseKey - The base key; defaults to `defaultCacheKey(ctx)`
 * @param vary - Optional discriminator function
 * @returns The composed cache key
 */
export function composeCacheKey(
  ctx: IRequestContext,
  baseKey?: string,
  vary?: (ctx: IRequestContext) => readonly string[],
): string {
  const base = baseKey !== undefined ? baseKey : defaultCacheKey(ctx);
  return tenantSegment(ctx) + varySegment(ctx, vary) + base;
}
