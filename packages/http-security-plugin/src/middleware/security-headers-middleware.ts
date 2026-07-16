/**
 * Security headers middleware factory.
 *
 * Sets security response headers before calling next(), so they persist
 * through handler execution and any downstream short-circuits.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

/** Options for Content-Security-Policy header. */
export interface ContentSecurityPolicyOptions {
  /** Default source directive. */
  readonly defaultSrc?: string;
  /** Script source directive. */
  readonly scriptSrc?: string;
  /** Style source directive. */
  readonly styleSrc?: string;
  /** Image source directive. */
  readonly imgSrc?: string;
  /** Connect source directive. */
  readonly connectSrc?: string;
  /** Font source directive. */
  readonly fontSrc?: string;
  /** Object source directive. */
  readonly objectSrc?: string;
  /** Media source directive. */
  readonly mediaSrc?: string;
  /** Frame source directive. */
  readonly frameSrc?: string;
  /** Report URI for CSP violations. */
  readonly reportUri?: string;
}

/** Options for Strict-Transport-Security header. */
export interface StrictTransportSecurityOptions {
  /** Max age in seconds. Default: 31536000 (1 year). */
  readonly maxAge?: number;
  /** Include subdomains. Default: true. */
  readonly includeSubDomains?: boolean;
  /** Preload directive. */
  readonly preload?: boolean;
}

/** Options for security headers middleware. */
export interface SecurityHeadersOptions {
  /** Enable/disable all security headers. Defaults to `true`. */
  readonly enabled?: boolean;
  /**
   * Content-Security-Policy configuration.
   * Set to `false` to omit entirely.
   * `undefined` keeps the default (no CSP by default since it breaks apps).
   */
  readonly contentSecurityPolicy?: ContentSecurityPolicyOptions | false;
  /**
   * Strict-Transport-Security configuration.
   * Set to `false` to omit. `undefined` uses defaults.
   */
  readonly strictTransportSecurity?: StrictTransportSecurityOptions | false;
  /**
   * X-Frame-Options value.
   * Set to `false` to omit. `undefined` uses default (`DENY`).
   */
  readonly xFrameOptions?: string | false;
  /**
   * X-Content-Type-Options value.
   * Set to `false` to omit. `undefined` uses default (`nosniff`).
   */
  readonly xContentTypeOptions?: string | false;
  /**
   * Referrer-Policy value.
   * Set to `false` to omit. `undefined` uses default (`no-referrer`).
   */
  readonly referrerPolicy?: string | false;
  /**
   * Permissions-Policy value.
   * Set to `false` to omit. `undefined` uses default (none by default).
   */
  readonly permissionsPolicy?: string | false;
}

/** Default header values applied when options are omitted. */
const DEFAULTS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

/**
 * Security headers middleware factory.
 *
 * @param options - Security headers configuration
 * @returns A middleware function that sets security headers
 */
export function securityHeadersMiddleware(
  options: SecurityHeadersOptions = {},
): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const headersToSet = buildHeaders(options);

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void> => {
    for (const [name, value] of headersToSet) {
      ctx.response.header(name, value);
    }
    await next();
  };
}

/**
 * Builds the map of headers to set based on options.
 *
 * @param options - Security headers options
 * @returns Array of [name, value] pairs
 */
function buildHeaders(options: SecurityHeadersOptions): Array<[string, string]> {
  const headers: Array<[string, string]> = [];

  // X-Content-Type-Options (default: nosniff)
  const xcto = options.xContentTypeOptions;
  if (xcto === false) {
    // explicitly omitted
  } else {
    headers.push(['X-Content-Type-Options', xcto ?? DEFAULTS['x-content-type-options']]);
  }

  // X-Frame-Options (default: DENY)
  const xfo = options.xFrameOptions;
  if (xfo === false) {
    // explicitly omitted
  } else {
    headers.push(['X-Frame-Options', xfo ?? DEFAULTS['x-frame-options']]);
  }

  // Referrer-Policy (default: no-referrer)
  const rp = options.referrerPolicy;
  if (rp === false) {
    // explicitly omitted
  } else {
    headers.push(['Referrer-Policy', rp ?? DEFAULTS['referrer-policy']]);
  }

  // Strict-Transport-Security (default: max-age=31536000; includeSubDomains)
  const hsts = options.strictTransportSecurity;
  if (hsts === false) {
    // explicitly omitted
  } else if (hsts === undefined) {
    // Use default
    headers.push(['Strict-Transport-Security', DEFAULTS['strict-transport-security']]);
  } else {
    // Build from options
    const maxAge = hsts.maxAge ?? 31536000;
    const parts = [`max-age=${maxAge}`];
    if (hsts.includeSubDomains !== false) {
      parts.push('includeSubDomains');
    }
    if (hsts.preload) {
      parts.push('preload');
    }
    headers.push(['Strict-Transport-Security', parts.join('; ')]);
  }

  // Content-Security-Policy (no default — only when explicitly configured)
  const csp = options.contentSecurityPolicy;
  if (csp !== false && csp !== undefined) {
    const cspValue = buildCspValue(csp);
    if (cspValue) {
      headers.push(['Content-Security-Policy', cspValue]);
    }
  }

  // Permissions-Policy (no default — only when explicitly configured)
  const pp = options.permissionsPolicy;
  if (pp !== false && pp !== undefined) {
    headers.push(['Permissions-Policy', pp]);
  }

  return headers;
}

/**
 * Builds a CSP directive string from ContentSecurityPolicyOptions.
 *
 * @param options - CSP options
 * @returns The CSP directive string, or empty string if no directives
 */
function buildCspValue(options: ContentSecurityPolicyOptions): string {
  const directives: string[] = [];

  const map: Readonly<Record<string, keyof ContentSecurityPolicyOptions>> = {
    'default-src': 'defaultSrc',
    'script-src': 'scriptSrc',
    'style-src': 'styleSrc',
    'img-src': 'imgSrc',
    'connect-src': 'connectSrc',
    'font-src': 'fontSrc',
    'object-src': 'objectSrc',
    'media-src': 'mediaSrc',
    'frame-src': 'frameSrc',
  };

  for (const [directive, key] of Object.entries(map)) {
    const value = options[key];
    if (value !== undefined) {
      directives.push(`${directive} ${value}`);
    }
  }

  if (options.reportUri !== undefined) {
    directives.push(`report-uri ${options.reportUri}`);
  }

  return directives.join('; ');
}
