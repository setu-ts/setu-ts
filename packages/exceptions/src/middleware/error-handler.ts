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
import {
  brandErrorResponder,
  CAPABILITIES,
  ERROR_RESPONDER_STATE_KEY,
  httpStatusHintOf,
  resolveResponseStatus,
  serializeError,
} from '@setu-ts/common';

import { HttpError } from '../errors/http-error.ts';
import { internalServerError, statusTitle } from '../errors/exceptions.ts';
import { buildErrorFromInit, createErrorResponder } from './error-responder-impl.ts';
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
  // The responder is built ONCE at factory time from the formatter and content
  // type already resolved above, and published per request below: one
  // `Map.set` of a pre-built object, not a re-resolution (AI_GUIDELINES §14).
  const responder = createErrorResponder(formatter, contentType);

  const handleError = async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> => {
    // Publish the responder BEFORE `next()` so every site inside the pipeline
    // — the kernel's own terminals and every short-circuiting middleware —
    // answers in this application's configured format (M70f).
    ctx.state.set(ERROR_RESPONDER_STATE_KEY, responder);
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

      // A thrower that cannot import this package states the status its own
      // error means by branding it with an `HttpStatusHint` (M89b) — the seam
      // `@setu-ts/database-plugin` uses for its query-shape refusals, which
      // are caller errors and were answered as masked 500s. The hint carries
      // its own caller-safe `detail`, so the response is built from THAT and
      // never from the error's message, and `buildErrorFromInit` is the same
      // constructor `respondWithError` reaches: one mapping, one body shape.
      //
      // Read only for a non-`HttpError`. A deliberately thrown `HttpError`
      // already states its own status, and letting a brand override it would
      // give one error two answers.
      const hint = isHttpError ? undefined : httpStatusHintOf(rawError);

      // Mask a driver-shaped 500 for the response: the raw message becomes the
      // status title so the body carries neither the statement nor the values.
      // A deliberately thrown HttpError is never masked, and a 4xx is left
      // alone — only a non-HttpError with status >= 500 is rewritten.
      //
      // A hinted error is exempt, and the exemption is narrow by construction
      // rather than by trust: what it serves is the hint's own `detail`, a
      // fixed sentence the brand site wrote, never the `Error`'s message. So
      // there is no driver diagnostic in the body for masking to remove. It is
      // checked FIRST because a hinted 501 satisfies all three masking clauses
      // and would otherwise be rewritten into the exact symptom this closes.
      let responseError = error;
      if (hint !== undefined) {
        responseError = buildErrorFromInit(hint);
      } else if (maskInternalErrors && !isHttpError && error.statusCode >= 500) {
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

      // An `HttpError` carries whatever status its thrower passed: the
      // constructor validates nothing, and its own JSDoc says the factory
      // functions are what "guarantee a correct status code". So
      // `throw new HttpError(4004, ...)` — a typo for `404` — reached
      // `response.status()` and threw `RangeError` out of the one `catch` that
      // exists to contain throws. The status is clamped BEFORE the log and the
      // body are built, so the logged status, the body's own status member and
      // the written status are one number. Rebuilding rather than clamping at
      // the write also makes `responseError === error` false, which suppresses
      // the stack — correct by that check's own stated invariant, since the
      // error being SERVED is no longer the error that was LOGGED.
      const servedStatus = resolveResponseStatus(responseError.statusCode, ctx);
      if (servedStatus !== responseError.statusCode) {
        responseError = new HttpError(
          servedStatus,
          responseError.message,
          responseError.details,
          responseError.cause instanceof Error ? responseError.cause : undefined,
        );
      }

      // Log the UNMASKED error, so the log keeps the SQL, the bound parameters
      // and the cause chain regardless of masking — but report the status that
      // was actually SERVED. Masking preserves the status, so this is the same
      // number it always was; a hint does not (a `500`-normalized error is
      // answered `501`), and logging the pre-hint status would leave an
      // operator correlating a log line with a response looking for a `500`
      // that no client ever saw.
      if (logErrors) {
        logError(ctx, error, responseError.statusCode);
      }

      const body = formatter(responseError, ctx);
      // Masking wins over `includeStackTrace`. A stack's first line is
      // `<name>: <message>`, so attaching the unmasked error's stack would put
      // the SQL and its bound parameter values straight back into the body that
      // was just masked — defeating the mask through the one option documented
      // as unsafe in production. A masked error therefore carries no stack at
      // all; the unmasked one is in the log, where `logErrors` already sent it.
      //
      // The condition is `responseError === error` rather than `!masked`
      // because a hinted response is the second case with the same property:
      // its body deliberately carries the brand site's sentence and not the
      // error's own text, and a stack's first line is `<name>: <message>`. So
      // the stack is attached exactly when the error being SERVED is the error
      // that was LOGGED, which is the invariant both exclusions want.
      if (includeStackTrace && responseError === error && error.stack !== undefined) {
        body.stack = error.stack;
      }

      // Serialize and send via `.send(bytes)` rather than `.json(body)` so
      // the content-type header we set is not overwritten by json()'s own
      // `application/json` default — RFC 9457 requires `application/problem+json`.
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return ctx.response
        .status(responseError.statusCode)
        .header('content-type', contentType)
        .send(bytes);
    }
  };

  // Brand the middleware with the SAME responder it publishes into `ctx.state`
  // below, so the kernel can seed it into the state of the pre-pipeline sites
  // — the drain `503`, the malformed-request `400`, and the request-lifecycle
  // hooks — which run before this middleware and would otherwise always take
  // the fallback shape (M70f re-review, findings 1 & 2).
  brandErrorResponder(handleError, responder);
  return handleError;
}

/**
 * Logs an error via the registered `ILogger`, if one is available. Silently
 * does nothing when no logger capability is registered.
 *
 * @param ctx - The request context
 * @param error - The error to log, carrying the unmasked message and cause
 * @param statusCode - The status actually served, which a hint may have changed
 */
function logError(ctx: IRequestContext, error: HttpError, statusCode: number): void {
  if (!ctx.services.has(CAPABILITIES.LOGGER)) {
    return;
  }
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  // Serialize the cause (X2-5): a raw `Error` in log metadata renders as `{}`
  // under `JSON.stringify` because `message`/`stack` are non-enumerable.
  logger.error(error.message, {
    statusCode,
    requestId: ctx.id,
    ...(error.cause !== undefined && { cause: serializeError(error.cause) }),
  });
}
