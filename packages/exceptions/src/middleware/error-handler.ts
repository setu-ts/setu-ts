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
 * import { errorHandler } from '@setu-ts/exceptions';
 *
 * app.middleware.add(errorHandler({
 *   format: 'rfc9457',
 *   includeStackTrace: config.get('NODE_ENV') === 'development',
 *   logErrors: true,
 * }), { priority: 0, name: 'error-handler' });
 * ```
 *
 * @module
 */
import type { HandlerResult, ILogger, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { HttpError } from '../errors/http-error.ts';
import { internalServerError, statusTitle } from '../errors/exceptions.ts';
import {
  type ErrorFormat,
  type ErrorHandlerFormatter,
  selectFormatter,
} from '../formatters/error-formatter.ts';
import { rfc9457Formatter } from '../formatters/rfc9457-formatter.ts';
import { rfc7807Formatter } from '../formatters/rfc7807-formatter.ts';

/**
 * Options for the {@linkcode errorHandler} middleware factory.
 *
 * @since 0.1.0
 */
export interface ErrorHandlerOptions {
  /**
   * The error body format: `'default'`, `'rfc9457'`, the deprecated
   * `'rfc7807'`, or a custom formatter function. Defaults to `'default'`.
   */
  readonly format?: ErrorFormat | ErrorHandlerFormatter;
  /**
   * When `true`, the error `stack` trace is included in the response body.
   * **Never** enable this in production — pass a config-derived boolean (e.g.
   * `config.get('NODE_ENV') === 'development'`), never read `process.env`
   * directly (AI_GUIDELINES §4.1). Defaults to `false`.
   *
   * Note the stack is the _secondary_ disclosure: the primary one is the
   * error **message**, which for a failed query carries the SQL and its bound
   * parameter values. Masking that is `maskInternalErrors`' job.
   *
   * The two compose safely, and masking wins: an error masked by
   * {@linkcode ErrorHandlerOptions.maskInternalErrors} carries **no** stack in
   * the body even when this option is `true`, because a stack begins with the
   * very message that was masked. Set `maskInternalErrors: false` to see the
   * stack of an internal error.
   */
  readonly includeStackTrace?: boolean;
  /**
   * When `true` (the default), a caught value that was **not** an
   * {@linkcode HttpError} and resolves to a status `>= 500` is masked in the
   * response: its `detail`/`message` becomes the status title
   * (`'Internal Server Error'`) and the raw message — which for a failed
   * query carries the SQL and its bound parameter values — is dropped from the
   * body. The log is unaffected: `logErrors` still records the unmasked error
   * and its cause chain, so an operator loses nothing unless `logErrors` is
   * _also_ `false`, the configuration that already logs nothing.
   *
   * A deliberately thrown `HttpError` is never masked — `instanceof HttpError`
   * is the line between "the developer wrote this for a caller" and "this
   * escaped from a driver". `false` restores the previous behaviour verbatim.
   */
  readonly maskInternalErrors?: boolean;
  /**
   * When `true` (the default), caught errors are logged at `error` level via
   * the `ILogger` resolved from `ctx.services` — but only if a logger is
   * registered. When no logger is present, logging is silently skipped.
   */
  readonly logErrors?: boolean;
}

/** The `application/problem+json` content type for Problem Details responses. */
const PROBLEM_JSON = 'application/problem+json';
/** The default JSON content type. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * The formatters whose bodies are Problem Details and therefore require the
 * `application/problem+json` media type (RFC 9457 §3).
 *
 * Membership is keyed on the RESOLVED formatter rather than on the format
 * string, because both formatters are exported: `format: rfc9457Formatter`
 * passes a reference and must carry the same media type as `format: 'rfc9457'`.
 * A body served as `application/json` is ignored by generic problem-details
 * clients, so a formatter missing from this set is a silent interoperability
 * defect rather than a visible failure.
 */
const PROBLEM_DETAILS_FORMATTERS: ReadonlySet<ErrorHandlerFormatter> = new Set([
  rfc9457Formatter,
  rfc7807Formatter,
]);

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
  const maskInternalErrors = options?.maskInternalErrors ?? true;
  const logErrors = options?.logErrors ?? true;
  const formatter = selectFormatter(format);
  const contentType = PROBLEM_DETAILS_FORMATTERS.has(formatter) ? PROBLEM_JSON : JSON_CONTENT_TYPE;

  return async function handleError(
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> {
    try {
      await next();
      return;
    } catch (rawError) {
      // Normalize: HttpError passes through, anything else becomes a 500.
      const isHttpError = rawError instanceof HttpError;
      const error: HttpError = isHttpError ? rawError : internalServerError(
        rawError instanceof Error ? rawError.message : 'Internal Server Error',
        rawError instanceof Error ? rawError : undefined,
      );

      // Log the UNMASKED error first, so the log keeps the SQL, the bound
      // parameters, and the cause chain regardless of masking.
      if (logErrors) {
        logError(ctx, error);
      }

      // Mask a driver-shaped 500 for the response: the raw message becomes the
      // status title so the body carries neither the statement nor the values.
      // A deliberately thrown HttpError is never masked, and a 4xx is left
      // alone — only a non-HttpError with status >= 500 is rewritten.
      let responseError = error;
      let masked = false;
      if (maskInternalErrors && !isHttpError && error.statusCode >= 500) {
        masked = true;
        // Preserve the log's cause chain without leaking the message. `cause`
        // is `unknown` on `Error`; only an `Error` value is a valid
        // `HttpError` cause, so narrow rather than cast.
        const cause = error.cause instanceof Error ? error.cause : undefined;
        responseError = new HttpError(
          error.statusCode,
          statusTitle(error.statusCode),
          undefined,
          cause,
        );
      }

      const body = formatter(responseError, ctx);
      // Masking wins over `includeStackTrace`. A stack's first line is
      // `<name>: <message>`, so attaching the unmasked error's stack would put
      // the SQL and its bound parameter values straight back into the body that
      // was just masked — defeating the mask through the one option documented
      // as unsafe in production. A masked error therefore carries no stack at
      // all; the unmasked one is in the log, where `logErrors` already sent it.
      if (includeStackTrace && !masked && error.stack !== undefined) {
        body.stack = error.stack;
      }

      // Serialize and send via `.send(bytes)` rather than `.json(body)` so
      // the content-type header we set is not overwritten by json()'s own
      // `application/json` default — RFC 9457 requires `application/problem+json`.
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
