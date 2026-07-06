/**
 * Global error-handler middleware factory.
 *
 * Returns a {@linkcode MiddlewareFunction} that wraps `next()` in a try/catch,
 * so any error thrown by downstream middleware or the route handler is caught,
 * logged (when a logger is registered), formatted, and sent as a JSON error
 * response. Register it as the **outermost** middleware (lowest priority number)
 * so it wraps the entire pipeline.
 *
 * @example
 * ```typescript
 * import { errorHandler } from '@hono-enterprise/exceptions';
 *
 * app.middleware.add(errorHandler({
 *   format: 'rfc7807',
 *   includeStackTrace: config.get('NODE_ENV') === 'development',
 *   logErrors: true,
 * }), { priority: 0, name: 'error-handler' });
 * ```
 *
 * @module
 */
import type {
  HandlerResult,
  ILogger,
  IRequestContext,
  MiddlewareFunction,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { HttpError } from '../errors/http-error.ts';
import { internalServerError } from '../errors/exceptions.ts';
import {
  type ErrorFormat,
  type ErrorHandlerFormatter,
  selectFormatter,
} from '../formatters/error-formatter.ts';

/**
 * Options for the {@linkcode errorHandler} middleware factory.
 *
 * @since 0.1.0
 */
export interface ErrorHandlerOptions {
  /**
   * The error body format: `'default'`, `'rfc7807'`, or a custom formatter
   * function. Defaults to `'default'`.
   */
  readonly format?: ErrorFormat | ErrorHandlerFormatter;
  /**
   * When `true`, the error `stack` trace is included in the response body.
   * **Never** enable this in production — pass a config-derived boolean (e.g.
   * `config.get('NODE_ENV') === 'development'`), never read `process.env`
   * directly (AI_GUIDELINES §4.1). Defaults to `false`.
   */
  readonly includeStackTrace?: boolean;
  /**
   * When `true` (the default), caught errors are logged at `error` level via
   * the `ILogger` resolved from `ctx.services` — but only if a logger is
   * registered. When no logger is present, logging is silently skipped.
   */
  readonly logErrors?: boolean;
}

/** The `application/problem+json` content type for RFC 7807 responses. */
const PROBLEM_JSON = 'application/problem+json';
/** The default JSON content type. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Creates a global error-handler middleware.
 *
 * Behavior:
 * 1. Calls `next()` inside a try/catch.
 * 2. If `next()` throws an `HttpError`, its `statusCode` is used as-is.
 * 3. If `next()` throws any other `Error`, it is wrapped in a `500`
 *    `internalServerError` carrying the original as `cause`.
 * 4. When `logErrors` is on and a logger is registered, the error is logged.
 * 5. The error body is formatted via {@linkcode selectFormatter}, optionally
 *    enriched with a `stack` trace, then sent with the right status and
 *    content type. The middleware **returns a `HandlerResult`** (short-circuit)
 *    and never re-invokes `next()`.
 *
 * @param options - Error handler configuration
 * @returns A middleware function
 * @since 0.1.0
 */
export function errorHandler(options?: ErrorHandlerOptions): MiddlewareFunction {
  const format = options?.format ?? 'default';
  const includeStackTrace = options?.includeStackTrace ?? false;
  const logErrors = options?.logErrors ?? true;
  const formatter = selectFormatter(format);
  const isRfc7807 = format === 'rfc7807';
  const contentType = isRfc7807 ? PROBLEM_JSON : JSON_CONTENT_TYPE;

  return async function handleError(
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> {
    try {
      await next();
      return;
    } catch (rawError) {
      // Normalize: HttpError passes through, anything else becomes a 500.
      const error: HttpError = rawError instanceof HttpError ? rawError : internalServerError(
        rawError instanceof Error ? rawError.message : 'Internal Server Error',
        rawError instanceof Error ? rawError : undefined,
      );

      if (logErrors) {
        logError(ctx, error);
      }

      const body = formatter(error, ctx);
      if (includeStackTrace && error.stack !== undefined) {
        body.stack = error.stack;
      }

      // Serialize and send via `.send(bytes)` rather than `.json(body)` so
      // the content-type header we set is not overwritten by json()'s own
      // `application/json` default — RFC 7807 requires `application/problem+json`.
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return ctx.response
        .status(error.statusCode)
        .header('content-type', contentType)
        .send(bytes);
    }
  };
}

/**
 * Logs an error via the registered `ILogger`, if one is available. Silently
 * does nothing when no logger capability is registered.
 *
 * @param ctx - The request context
 * @param error - The error to log
 */
function logError(ctx: IRequestContext, error: HttpError): void {
  if (!ctx.services.has(CAPABILITIES.LOGGER)) {
    return;
  }
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  logger.error(error.message, {
    statusCode: error.statusCode,
    requestId: ctx.id,
    ...(error.cause !== undefined && { cause: error.cause }),
  });
}
