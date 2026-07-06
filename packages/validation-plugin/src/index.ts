/**
 * @module
 *
 * Zod-compatible request validation plugin with RFC 7807 error formatting,
 * input sanitization, and middleware helpers.
 *
 * @example
 * ```typescript
 * import { ValidationPlugin, validateBody, validateQuery } from '@hono-enterprise/validation-plugin';
 *
 * app.register(ValidationPlugin({ errorFormat: 'rfc7807' }));
 *
 * app.router.post('/users', {
 *   middleware: [validateBody(CreateUserSchema)],
 *   handler: async (ctx) => {
 *     const body = ctx.state.get('validatedBody');
 *     // body is validated
 *   },
 * });
 * ```
 */

// Plugin factory
export { ValidationPlugin } from './plugin/validation-plugin.ts';
export type { ValidationPluginOptions } from './plugin/validation-plugin.ts';

// Service
export { ValidationService } from './services/validation-service.ts';

// Middleware helpers
export {
  createValidationMiddleware,
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from './middleware/validation-middleware.ts';

// Sanitizer
export { createSanitizer, sanitize } from './sanitizers/sanitizer.ts';
export type { SanitizationRules } from './sanitizers/sanitizer.ts';

// Formatters
export { defaultFormatter, nestjsFormatter } from './formatters/default-formatter.ts';
export { rfc7807Formatter } from './formatters/rfc7807-formatter.ts';
export { resolveFormatter } from './formatters/error-formatter.ts';
export type {
  ErrorFormat,
  FormattedError,
  FormatValidationErrors,
  ValidationErrorFormatter,
} from './formatters/error-formatter.ts';
