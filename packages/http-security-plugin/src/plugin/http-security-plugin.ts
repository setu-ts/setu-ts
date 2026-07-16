/**
 * HttpSecurityPlugin factory.
 *
 * Registers CORS, security headers, CSRF, request-size, and IP-security
 * middleware as global middleware on the kernel pipeline. Middleware-only —
 * no capability token, no service.
 *
 * @module
 */
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';
import { PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { CorsOptions } from '../middleware/cors-middleware.ts';
import { corsMiddleware } from '../middleware/cors-middleware.ts';
import type { SecurityHeadersOptions } from '../middleware/security-headers-middleware.ts';
import { securityHeadersMiddleware } from '../middleware/security-headers-middleware.ts';
import type { CsrfOptions } from '../middleware/csrf-middleware.ts';
import { csrfMiddleware } from '../middleware/csrf-middleware.ts';
import type { RequestSizeOptions } from '../middleware/request-size-middleware.ts';
import { requestSizeMiddleware } from '../middleware/request-size-middleware.ts';
import type { IpSecurityOptions } from '../middleware/ip-security-middleware.ts';
import { ipSecurityMiddleware } from '../middleware/ip-security-middleware.ts';

/** Middleware execution priorities for each concern. */
const MIDDLEWARE_PRIORITY = {
  IP_SECURITY: 120,
  REQUEST_SIZE: 180,
  CORS: 200,
  SECURITY_HEADERS: 250,
  CSRF: 270,
} as const;

/** Options for HttpSecurityPlugin. */
export interface HttpSecurityPluginOptions {
  /** CORS configuration. Presence enables CORS; absent means inactive. */
  readonly cors?: CorsOptions;
  /**
   * Security headers configuration. Omitted → default secure header set.
   * `{ enabled: false }` → off. Sub-fields override individual headers.
   */
  readonly headers?: SecurityHeadersOptions;
  /** CSRF configuration. Presence enables CSRF; absent means inactive. */
  readonly csrf?: CsrfOptions;
  /** Request-size configuration. Presence enables size limiting; absent means inactive. */
  readonly requestSize?: RequestSizeOptions;
  /** IP security configuration. Presence enables IP resolution; absent means inactive. */
  readonly ipSecurity?: IpSecurityOptions;
}

/**
 * HttpSecurityPlugin factory.
 *
 * Creates a middleware-only plugin that registers security concerns:
 * - Security headers (ON by default)
 * - CORS (opt-in via `cors` option block)
 * - CSRF (opt-in via `csrf` option block)
 * - Request-size (opt-in via `requestSize` option block)
 * - IP security (opt-in via `ipSecurity` option block)
 *
 * @param options - Plugin configuration options
 * @returns A configured IPlugin instance
 *
 * @example
 * ```typescript
 * app.register(HttpSecurityPlugin({
 *   cors: { origin: 'https://example.com', credentials: true },
 *   csrf: { trustedOrigins: ['https://example.com'] },
 * }));
 * ```
 */
export function HttpSecurityPlugin(
  options: HttpSecurityPluginOptions = {},
): IPlugin {
  return {
    name: 'http-security-plugin',
    version: '0.1.0',
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      // Security headers: ON by default (even when `headers` is omitted)
      const headersOptions: SecurityHeadersOptions = options.headers ?? {};
      ctx.middleware.add(securityHeadersMiddleware(headersOptions), {
        priority: MIDDLEWARE_PRIORITY.SECURITY_HEADERS,
        name: 'SecurityHeadersMiddleware',
      });

      // CORS: opt-in (only when `cors` option block is present)
      if (options.cors !== undefined) {
        ctx.middleware.add(corsMiddleware(options.cors), {
          priority: MIDDLEWARE_PRIORITY.CORS,
          name: 'CorsMiddleware',
        });
      }

      // CSRF: opt-in (only when `csrf` option block is present)
      if (options.csrf !== undefined) {
        ctx.middleware.add(csrfMiddleware(options.csrf), {
          priority: MIDDLEWARE_PRIORITY.CSRF,
          name: 'CsrfMiddleware',
        });
      }

      // Request-size: opt-in (only when `requestSize` option block is present)
      if (options.requestSize !== undefined) {
        ctx.middleware.add(requestSizeMiddleware(options.requestSize), {
          priority: MIDDLEWARE_PRIORITY.REQUEST_SIZE,
          name: 'RequestSizeMiddleware',
        });
      }

      // IP security: opt-in (only when `ipSecurity` option block is present)
      if (options.ipSecurity !== undefined) {
        ctx.middleware.add(ipSecurityMiddleware(options.ipSecurity), {
          priority: MIDDLEWARE_PRIORITY.IP_SECURITY,
          name: 'IpSecurityMiddleware',
        });
      }
    },
  };
}
