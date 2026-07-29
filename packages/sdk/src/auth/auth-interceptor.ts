/**
 * Authentication interceptor factories.
 *
 * Provides `createBearerAuthInterceptor` and `createApiKeyAuthInterceptor` that
 * accept a literal string or an async provider function, setting the appropriate
 * header only when the request has not already supplied one.
 *
 * @module
 */

import type { ClientRequestContext, ClientRequestInterceptor } from '../http/contracts.ts';

/**
 * Create a request interceptor that sets `Authorization: Bearer <token>`.
 *
 * Accepts a static token or an async provider. The header is only set when the
 * request does not already carry an `authorization` header, allowing per-endpoint
 * credential override.
 *
 * @param token - Static bearer token or async provider returning one.
 * @returns A request interceptor.
 * @since 0.1.0
 */
export function createBearerAuthInterceptor(
  token: string | (() => Promise<string>),
): ClientRequestInterceptor {
  return async (ctx: ClientRequestContext) => {
    if (ctx.headers.has('authorization')) return;
    const value = typeof token === 'function' ? await token() : token;
    ctx.headers.set('Authorization', `Bearer ${value}`);
  };
}

/**
 * Create a request interceptor that sets an API-key header.
 *
 * The default header name is `X-API-Key`. The header is only set when the
 * request does not already carry that header.
 *
 * @param key - Static API key or async provider returning one.
 * @param headerName - Header name (default `X-API-Key`).
 * @returns A request interceptor.
 * @since 0.1.0
 */
export function createApiKeyAuthInterceptor(
  key: string | (() => Promise<string>),
  headerName = 'X-API-Key',
): ClientRequestInterceptor {
  return async (ctx: ClientRequestContext) => {
    if (ctx.headers.has(headerName)) return;
    const value = typeof key === 'function' ? await key() : key;
    ctx.headers.set(headerName, value);
  };
}
