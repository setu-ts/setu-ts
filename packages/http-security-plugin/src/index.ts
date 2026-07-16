/**
 * @module
 *
 * HTTP transport security plugin: CORS, security headers, CSRF, request size,
 * IP security. Middleware-only plugin with no capability token or service.
 *
 * @example
 * ```typescript
 * import { HttpSecurityPlugin, corsMiddleware } from '@hono-enterprise/http-security-plugin';
 *
 * app.register(HttpSecurityPlugin({
 *   cors: { origin: 'https://example.com', credentials: true },
 *   csrf: { trustedOrigins: ['https://example.com'] },
 * }));
 *
 * // Per-route use of standalone factories:
 * app.router.get('/api', {
 *   middleware: [corsMiddleware({ origin: 'https://other.com' })],
 *   handler: (ctx) => ctx.response.json({ ok: true }),
 * });
 * ```
 */

// Plugin factory
export { HttpSecurityPlugin } from './plugin/http-security-plugin.ts';
export type { HttpSecurityPluginOptions } from './plugin/http-security-plugin.ts';

// Middleware factories
export { corsMiddleware } from './middleware/cors-middleware.ts';
export type { CorsOptions, CorsOriginMatcher } from './middleware/cors-middleware.ts';

export { securityHeadersMiddleware } from './middleware/security-headers-middleware.ts';
export type {
  ContentSecurityPolicyOptions,
  SecurityHeadersOptions,
  StrictTransportSecurityOptions,
} from './middleware/security-headers-middleware.ts';

export { csrfMiddleware } from './middleware/csrf-middleware.ts';
export type { CsrfOptions } from './middleware/csrf-middleware.ts';

export { requestSizeMiddleware } from './middleware/request-size-middleware.ts';
export type { RequestSizeOptions } from './middleware/request-size-middleware.ts';

export { ipSecurityMiddleware } from './middleware/ip-security-middleware.ts';
export type { IpSecurityOptions } from './middleware/ip-security-middleware.ts';
