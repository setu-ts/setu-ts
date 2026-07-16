/**
 * CORS middleware factory.
 *
 * Handles origin matching, preflight short-circuit (204), credentials
 * reflection, and Vary header management.
 *
 * @module
 */
import type { HandlerResult, IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

/** Origin matcher function for dynamic CORS decisions. */
export type CorsOriginMatcher = (
  origin: string,
  ctx: IRequestContext,
) => string | boolean | Promise<string | boolean>;

/** Options for CORS middleware. */
export interface CorsOptions {
  /** Enable/disable CORS. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * Origin configuration:
   * - `true` — reflect the request Origin header
   * - `false` — deny all cross-origin
   * - `string` — single allowed origin
   * - `readonly string[]` — allowlist of origins
   * - `CorsOriginMatcher` — dynamic matcher
   * Default: empty allowlist (deny all cross-origin).
   */
  readonly origin?: boolean | string | readonly string[] | CorsOriginMatcher;
  /** When `true`, emit `Access-Control-Allow-Credentials: true`. */
  readonly credentials?: boolean;
  /** Allowed methods for preflight `Allow-Methods` header. */
  readonly methods?: readonly string[];
  /** Allowed request headers for preflight `Allow-Headers` header. */
  readonly allowedHeaders?: readonly string[];
  /** Exposed response headers for `Access-Control-Expose-Headers`. */
  readonly exposedHeaders?: readonly string[];
  /** Max age (seconds) for preflight cache. */
  readonly maxAge?: number;
}

/**
 * CORS middleware factory.
 *
 * @param options - CORS configuration
 * @returns A middleware function implementing CORS
 */
export function corsMiddleware(options: CorsOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const origin = options.origin ?? [];
  const credentials = options.credentials ?? false;
  const methods = options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const allowedHeaders = options.allowedHeaders ?? [];
  const exposedHeaders = options.exposedHeaders ?? [];
  const maxAge = options.maxAge;

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> => {
    const requestOrigin = ctx.request.headers.get('Origin');

    // No Origin header — not a CORS request, pass through
    if (!requestOrigin) {
      await next();
      return;
    }

    // Determine if the origin is allowed
    const allowedOrigin = await resolveOrigin(origin, requestOrigin, ctx);
    if (!allowedOrigin) {
      // Disallowed origin
      // Check if this is a preflight request
      if (
        ctx.request.method === 'OPTIONS' &&
        ctx.request.headers.get('Access-Control-Request-Method')
      ) {
        // Preflight with disallowed origin — 204 with no CORS headers, short-circuit
        return ctx.response.status(204).send();
      }
      // Non-preflight with disallowed origin — call next() with no CORS headers
      // (the browser enforces the block)
      await next();
      return;
    }

    // This is a preflight request — short-circuit with 204
    if (
      ctx.request.method === 'OPTIONS' &&
      ctx.request.headers.get('Access-Control-Request-Method')
    ) {
      ctx.response.status(204);
      ctx.response.header('Access-Control-Allow-Origin', allowedOrigin);
      ctx.response.appendHeader('Vary', 'Origin');

      if (credentials) {
        ctx.response.header('Access-Control-Allow-Credentials', 'true');
      }
      ctx.response.header('Access-Control-Allow-Methods', methods.join(', '));

      if (allowedHeaders.length > 0) {
        ctx.response.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      }
      if (maxAge !== undefined) {
        ctx.response.header('Access-Control-Max-Age', String(maxAge));
      }

      return ctx.response.send();
    }

    // Non-preflight CORS request — set headers and proceed
    ctx.response.header('Access-Control-Allow-Origin', allowedOrigin);
    ctx.response.appendHeader('Vary', 'Origin');

    if (credentials) {
      ctx.response.header('Access-Control-Allow-Credentials', 'true');
    }
    if (exposedHeaders.length > 0) {
      ctx.response.header('Access-Control-Expose-Headers', exposedHeaders.join(', '));
    }

    await next();
  };
}

/**
 * Resolves the origin configuration against a request origin.
 *
 * @param config - The origin configuration
 * @param requestOrigin - The Origin header value from the request
 * @param ctx - The request context (for matcher functions)
 * @returns The allowed origin string, or `null` if not allowed
 */
async function resolveOrigin(
  config: CorsOptions['origin'],
  requestOrigin: string,
  ctx: IRequestContext,
): Promise<string | null> {
  if (config === true) {
    // Reflect the request origin
    return requestOrigin;
  }
  if (config === false) {
    // Deny all
    return null;
  }
  if (typeof config === 'string') {
    // Single origin
    return config === requestOrigin ? config : null;
  }
  if (Array.isArray(config)) {
    // Allowlist
    return config.includes(requestOrigin) ? requestOrigin : null;
  }
  // Dynamic matcher function
  if (typeof config !== 'function') {
    return null;
  }
  const result = await config(requestOrigin, ctx);
  if (result === true) {
    return requestOrigin;
  }
  if (typeof result === 'string') {
    return result;
  }
  return null;
}
