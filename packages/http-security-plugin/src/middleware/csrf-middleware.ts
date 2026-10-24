/**
 * CSRF middleware factory.
 *
 * Stateless Origin/Referer validation for unsafe HTTP methods, plus an
 * optional custom-header requirement. No cookies or server-side token store.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction, PathPattern } from '@setu-ts/common';
import { createPathMatcher, respondWithError, requestOriginOf } from '@setu-ts/common';
import { xForwardedOrigin } from './ip-security-middleware.ts';

/** HTTP methods considered unsafe (mutable) for CSRF purposes. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Options for CSRF middleware. */
export interface CsrfOptions {
  /** Enable/disable CSRF protection. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * Additional trusted origins (scheme+host) beyond the request's own origin.
   * Implicitly trusts the URL origin; the published public origin unless the
   * browser reports `Sec-Fetch-Site` as anything but `same-origin`; and — only
   * when it reports `same-origin` — the validated leftmost X-Forwarded
   * protocol/host candidate. Scripts cannot set `Sec-Fetch-Site`, while they
   * can set `X-Forwarded-*` on a CORS request the server admits, so either
   * forwarded candidate alone would let a credentialed CORS origin pass. This
   * comparison grants no proxy trust to other consumers. Default: `[]`.
   *
   * An origin allowlist cannot admit an IdP that serves
   * `Referrer-Policy: no-referrer` (Keycloak does): the browser posts the ACS
   * with `Origin: null`, and `trustedOrigins: ['null']` admits every
   * opaque-origin `POST` on every route. For such an endpoint use
   * {@linkcode CsrfOptions.exclude} instead (M101c, V8-9).
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * When set, unsafe methods must carry this custom header or the request
   * is rejected with 403. Simple form submits cannot set custom headers
   * without a preflight, making this a CSRF defense.
   */
  readonly customHeader?: string;
  /**
   * Request paths exempt from CSRF validation, matched against
   * `ctx.request.path` by exact string equality or `RegExp.test`. An
   * excluded path is checked FIRST — before the method test — and is never
   * inspected. Default: `[]` (no path is exempt).
   *
   * Use this only for a protocol endpoint whose own defences make the CSRF
   * check redundant — the SAML ACS, whose signed assertion, single-use
   * request and browser-binding cookie are the check this middleware would
   * otherwise add (M101c, V8-9). Do not use it to bypass CSRF for
   * application form routes.
   *
   * @since 0.9.0
   */
  readonly exclude?: readonly PathPattern[];
  /**
   * Accept `Origin: null` when the browser also sends
   * `Sec-Fetch-Site: same-origin`. Default `true` (since 0.11.0, M119c).
   *
   * Under the default `Referrer-Policy: no-referrer` a browser sends
   * `Origin: null` on a same-origin HTML form POST; `Sec-Fetch-Site` is set
   * by the browser and cannot be written by page script, and a sandboxed,
   * opaque-origin or cross-site initiator reports `cross-site`. `false`
   * restores the pre-0.11.0 refusal of every `null` origin, for an
   * application that prefers to send a real origin instead
   * (`referrerPolicy: 'same-origin'`). A non-boolean value throws `TypeError`
   * when the middleware is built.
   *
   * @since 0.11.0
   */
  readonly acceptNullOriginSameOrigin?: boolean;
}

/**
 * CSRF middleware factory.
 *
 * Accepts the exact Origin sentinel `null` when Fetch Metadata reports
 * `same-origin`, including navigation POSTs under the default no-referrer
 * policy, unless {@linkcode CsrfOptions.acceptNullOriginSameOrigin} is `false`.
 *
 * @param options - CSRF configuration
 * @returns A middleware function implementing CSRF protection
 * @throws {TypeError} When `acceptNullOriginSameOrigin` is not a boolean
 */
export function csrfMiddleware(options: CsrfOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const trustedOrigins = options.trustedOrigins ?? [];
  const customHeader = options.customHeader;
  // Read once and refused when malformed: a string `'false'` would otherwise
  // read as truthy and silently keep the acceptance the caller tried to turn off.
  const acceptNullSameOrigin = options.acceptNullOriginSameOrigin;
  if (acceptNullSameOrigin !== undefined && typeof acceptNullSameOrigin !== 'boolean') {
    throw new TypeError('csrfMiddleware: acceptNullOriginSameOrigin must be a boolean.');
  }
  const acceptNull = acceptNullSameOrigin ?? true;

  // The exclusion list is PARTITIONED once at registration (M90a's
  // `createPathMatcher` owns the `lastIndex` reset a `g`/`y`-flagged pattern
  // needs). Checked FIRST, before the method test, so an excluded path is
  // never inspected (M101c, V8-9).
  const isExcluded = createPathMatcher(options.exclude ?? []);

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Excluded paths skip the CSRF check entirely — no method test, no
    // origin inspection.
    if (isExcluded(ctx.request.path)) {
      await next();
      return;
    }

    // Safe methods always pass through
    if (!UNSAFE_METHODS.has(ctx.request.method.toUpperCase())) {
      await next();
      return;
    }

    // Custom header check (defense-in-depth)
    if (customHeader) {
      const headerValue = ctx.request.headers.get(customHeader);
      if (!headerValue) {
        respondWithError(ctx, {
          status: 403,
          title: 'Forbidden',
          detail: `Missing required CSRF custom header: ${customHeader}`,
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

    // A browser that reports the request as anything but same-origin cannot
    // legitimately carry the target's public origin, so neither forwarded
    // candidate is consulted: a trusted proxy passing a client's
    // `X-Forwarded-Host` through would otherwise let a credentialed CORS
    // origin publish, and then match, its own host (M113n audit N1).
    const fetchSite = ctx.request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase();
    // A no-referrer same-origin navigation can carry an opaque Origin.
    // Fetch Metadata is browser-owned; only this exact origin sentinel is admitted.
    if (acceptNull && sourceOrigin === 'null' && fetchSite === 'same-origin') {
      await next();
      return;
    }
    const forwardedCandidates = fetchSite === undefined || fetchSite === 'same-origin';

    // The request's own origin is always implicitly trusted
    if (
      requestOrigin &&
      (sourceOrigin === requestOrigin ||
        (forwardedCandidates &&
          (sourceOrigin === requestOriginOf(ctx).origin ||
            (fetchSite === 'same-origin' &&
              sameOriginBehindProxy(ctx, sourceOrigin, requestOrigin)))))
    ) {
      await next();
      return;
    }

    // Check explicit trusted origins
    if (trustedOrigins.includes(sourceOrigin)) {
      await next();
      return;
    }

    // Disallowed origin — reject with 403
    respondWithError(ctx, {
      status: 403,
      title: 'Forbidden',
      detail: 'Cross-origin request not allowed',
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

/**
 * The zero-configuration proxy candidate: an `X-Forwarded-Proto`/`X-Forwarded-Host`
 * origin, consulted only when the browser reports the request same-origin.
 *
 * `X-Forwarded-*` are not forbidden request headers, and the CORS middleware
 * echoes requested headers by default, so a script on a credentialed CORS
 * origin could otherwise send `X-Forwarded-Host: <its own host>` and match its
 * own `Origin` (M113n audit F1). `Sec-Fetch-Site` is forbidden to scripts.
 */
function sameOriginBehindProxy(
  ctx: IRequestContext,
  sourceOrigin: string,
  requestOrigin: string,
): boolean {
  const url = new URL(ctx.request.url);
  return (
    sourceOrigin ===
    xForwardedOrigin(ctx, {
      protocol: url.protocol === 'https:' ? 'https' : 'http',
      host: url.host,
      origin: requestOrigin,
    }).origin
  );
}
