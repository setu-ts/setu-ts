/**
 * CSRF middleware factory.
 *
 * Stateless Origin/Referer validation for unsafe HTTP methods, plus an
 * optional custom-header requirement. No cookies or server-side token store.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

/** HTTP methods considered unsafe (mutable) for CSRF purposes. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Options for CSRF middleware. */
export interface CsrfOptions {
  /** Enable/disable CSRF protection. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * Additional trusted origins (scheme+host) beyond the request's own origin.
   * The request's own origin (derived from `request.url`) is always implicitly
   * trusted. Default: `[]`.
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * When set, unsafe methods must carry this custom header or the request
   * is rejected with 403. Simple form submits cannot set custom headers
   * without a preflight, making this a CSRF defense.
   */
  readonly customHeader?: string;
}

/**
 * CSRF middleware factory.
 *
 * @param options - CSRF configuration
 * @returns A middleware function implementing CSRF protection
 */
export function csrfMiddleware(options: CsrfOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const trustedOrigins = options.trustedOrigins ?? [];
  const customHeader = options.customHeader;

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void> => {
    // Safe methods always pass through
    if (!UNSAFE_METHODS.has(ctx.request.method.toUpperCase())) {
      await next();
      return;
    }

    // Custom header check (defense-in-depth)
    if (customHeader) {
      const headerValue = ctx.request.headers.get(customHeader);
      if (!headerValue) {
        ctx.response
          .status(403)
          .json({
            error: 'Forbidden',
            message: `Missing required CSRF custom header: ${customHeader}`,
          });
        return;
      }
    }

    // Origin/Referer validation
    const sourceOrigin = extractOrigin(ctx.request);

    // If both Origin and Referer are absent, pass through (non-browser clients)
    if (!sourceOrigin) {
      await next();
      return;
    }

    // Check if the source origin is trusted
    const requestOrigin = getRequestOrigin(ctx.request.url);

    // The request's own origin is always implicitly trusted
    if (requestOrigin && sourceOrigin === requestOrigin) {
      await next();
      return;
    }

    // Check explicit trusted origins
    if (trustedOrigins.includes(sourceOrigin)) {
      await next();
      return;
    }

    // Disallowed origin — reject with 403
    ctx.response.status(403).json({
      error: 'Forbidden',
      message: 'Cross-origin request not allowed',
    });
  };
}

/**
 * Extracts the source origin from the request's Origin or Referer headers.
 *
 * Prefers `Origin` header; falls back to deriving origin from `Referer`.
 * Returns `null` if neither header is present.
 */
function extractOrigin(request: IRequestContext['request']): string | null {
  const origin = request.headers.get('Origin');
  if (origin) {
    return origin;
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}`;
    } catch {
      // Invalid Referer URL — treat as absent
      return null;
    }
  }

  return null;
}

/**
 * Derives the request's own origin (scheme+host) from `request.url`.
 *
 * @param url - The full request URL
 * @returns The origin string (e.g. `https://example.com`), or `null` on parse failure
 */
function getRequestOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
