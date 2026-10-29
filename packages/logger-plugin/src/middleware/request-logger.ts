/**
 * Request logging middleware — self-contained completion at info, arrival at
 * debug, with slow-request detection and thrown-error status prediction.
 *
 * @module
 */
import type {
  ILogger,
  IErrorResponder,
  IRequestContext,
  IRuntimeServices,
  MiddlewareFunction,
  PathPattern,
} from '@setu-ts/common';
import { CAPABILITIES, createPathMatcher, ERROR_RESPONDER_STATE_KEY } from '@setu-ts/common';

import { NoopLogger } from '../loggers/noop-logger.ts';

/**
 * Options for {@linkcode createRequestLoggerMiddleware}.
 *
 * @since 0.1.0
 */
export interface RequestLoggerOptions {
  /** Requests slower than this (ms) trigger a `warn` entry. Defaults to `5000`. */
  readonly slowRequestThreshold?: number;
  /**
   * Paths to skip logging (e.g. `['/health']`). A string is an EXACT match; a
   * `RegExp` is tested against the path.
   *
   * Default: `[]` — nothing is skipped, unchanged.
   */
  readonly excludePaths?: readonly PathPattern[];
}

/** Default slow-request threshold in milliseconds. */
const DEFAULT_SLOW_THRESHOLD = 5000;

/**
 * Creates middleware that logs completion at info and arrival at debug.
 *
 * The middleware resolves the {@linkcode ILogger} from the service registry
 * on every request, so it picks up any request-scoped child logger that a
 * preceding middleware may have registered with `override: true`.
 *
 * @example
 * ```typescript
 * app.middleware.add(createRequestLoggerMiddleware({ slowRequestThreshold: 1000 }));
 * ```
 * @param options - Configuration
 * @returns The middleware function
 * @since 0.1.0
 */
export function createRequestLoggerMiddleware(options?: RequestLoggerOptions): MiddlewareFunction {
  const threshold = options?.slowRequestThreshold ?? DEFAULT_SLOW_THRESHOLD;
  // Partitioned once at registration. All-string lists keep the `Set.has`
  // lookup this middleware performed inline before M90a.
  const isExcluded = createPathMatcher(options?.excludePaths ?? []);

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const path = ctx.request.path;
    if (isExcluded(path)) {
      await next();
      return;
    }

    const logger = resolveLogger(ctx);
    const runtime = resolveRuntime(ctx);
    const requestLogger = logger.child({ requestId: ctx.id });

    if (shouldLogReceived(requestLogger)) {
      requestLogger.debug('request received', {
        method: ctx.request.method,
        path,
      });
    }

    const start = ctx.startTime;
    let errored = false;
    let errorStatus: number | undefined;
    try {
      await next();
    } catch (err) {
      errored = true;
      const responder = ctx.state.get(ERROR_RESPONDER_STATE_KEY) as IErrorResponder | undefined;
      errorStatus = responder?.statusFor?.(err) ?? 500;
      throw err;
    } finally {
      const duration = runtime.hrtime() - start;
      // On a throw, errorHandler serves only after this finally has unwound.
      // Its pure rule predicts that response while the snapshot is still 200.
      const status = errorStatus ?? readStatus(ctx);
      requestLogger.info('request completed', {
        method: ctx.request.method,
        path,
        status,
        duration,
      });
      if (!errored && duration > threshold) {
        requestLogger.warn('slow request', {
          method: ctx.request.method,
          path,
          duration,
          threshold,
        });
      }
    }
  };
}

/** Avoids building disabled arrival metadata; unknown levels defer to the logger. */
function shouldLogReceived(logger: ILogger): boolean {
  try {
    const level = logger.level;
    return level !== 'fatal' && level !== 'error' && level !== 'warn' && level !== 'info';
  } catch {
    // A legacy or application logger may expose no readable level. Its debug
    // method remains responsible for filtering rather than losing the entry.
    return true;
  }
}

/**
 * Resolves the logger from the request context, falling back to a no-op
 * logger if none is registered (e.g. when the LoggerPlugin is absent).
 *
 * @param ctx - The request context
 * @returns A logger (real or no-op)
 */
function resolveLogger(ctx: IRequestContext): ILogger {
  if (ctx.services.has(CAPABILITIES.LOGGER)) {
    return ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  }
  // Fall back to a no-op logger so the middleware never throws when logging
  // is disabled.
  return new NoopLogger();
}

/**
 * Resolves runtime services from the service registry. The kernel always
 * registers CAPABILITIES.RUNTIME before request-scoped middleware runs, so
 * this is safe to call unconditionally.
 *
 * @param ctx - The request context
 * @returns Runtime services
 */
function resolveRuntime(ctx: IRequestContext): IRuntimeServices {
  return ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
}

/**
 * Reads the response status from the response builder.
 *
 * `IResponse.snapshot()` (added in M11, widened in M42) exposes the status, so
 * this is the real value. It previously read a `'responseStatus'` state slot
 * that nothing in the framework ever set — the comment claimed `IResponse` was
 * write-only, which stopped being true once `snapshot()` landed — so every
 * "request completed" entry logged `status: 0`.
 *
 * @param ctx - The request context
 * @returns The response status code
 */
function readStatus(ctx: IRequestContext): number {
  return ctx.response.snapshot().status;
}
