/**
 * @module
 *
 * Exception factory functions, `HttpError`, error formatters, and the global
 * error handler middleware.
 *
 * This is a **plain package** (not a plugin) — it depends on
 * `@hono-enterprise/common` only and exposes types, factories, and a
 * middleware factory. Register the middleware via the application's pipeline:
 *
 * ```typescript
 * import { errorHandler } from '@hono-enterprise/exceptions';
 *
 * app.middleware.add(errorHandler({ format: 'rfc7807' }), {
 *   priority: 0,
 *   name: 'error-handler',
 * });
 * ```
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

// Error type
export { HttpError } from './errors/http-error.ts';
export type { HttpErrorInit, ValidationError } from './errors/http-error.ts';

// Exception factories
export {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  notImplemented,
  serviceUnavailable,
  STATUS_TITLES,
  statusTitle,
  tooManyRequests,
  unauthorized,
  validationError,
} from './errors/exceptions.ts';

// Formatters
export { defaultFormatter, selectFormatter } from './formatters/error-formatter.ts';
export type {
  DefaultErrorBody,
  ErrorFormat,
  ErrorHandlerFormatter,
} from './formatters/error-formatter.ts';
export { ERROR_TYPE_BASE, rfc7807Formatter } from './formatters/rfc7807-formatter.ts';
export type { ProblemDetails } from './formatters/rfc7807-formatter.ts';

// Middleware
export { errorHandler } from './middleware/error-handler.ts';
export type { ErrorHandlerOptions } from './middleware/error-handler.ts';
