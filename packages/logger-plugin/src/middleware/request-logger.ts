/**
 * Request/response logging middleware — logs every incoming request and its
 * outgoing response, with slow-request detection and error capture.
 *
 * @module
 */
import type {
  ILogger,
  IRequestContext,
  IRuntimeServices,
  MiddlewareFunction,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { NoopLogger } from '../loggers/noop-logger.ts';

/**
 * Options for {@linkcode createRequestLoggerMiddleware}.
 *
 * @since 0.1.0
 */
export interface RequestLoggerOptions {
  /** Requests slower than this (ms) trigger a `warn` entry. Defaults to `5000`. */
  readonly slowRequestThreshold?: number;
  /** Exact paths to skip logging (e.g. `['/health']`). */
  readonly excludePaths?: readonly string[];
}

/** Default slow-request threshold in milliseconds. */
const DEFAULT_SLOW_THRESHOLD = 5000;

/**
 * Creates middleware that logs each request and its response.
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
export function createRequestLoggerMiddleware(
  options?: RequestLoggerOptions,
): MiddlewareFunction {
  const threshold = options?.slowRequestThreshold ?? DEFAULT_SLOW_THRESHOLD;
  const exclude = new Set(options?.excludePaths ?? []);

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const path = ctx.request.path;
    if (exclude.has(path)) {
      await next();
      return;
    }

    const logger = resolveLogger(ctx);
    const runtime = resolveRuntime(ctx);
    const requestLogger = logger.child({ requestId: ctx.id });

    requestLogger.info('request received', {
      method: ctx.request.method,
      path,
    });

    const start = ctx.startTime;
    let errored = false;
    try {
      await next();
    } catch (err) {
      errored = true;
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      requestLogger.error('request failed', { error: message, stack });
      throw err;
    } finally {
      const duration = runtime.hrtime() - start;
      // Determine the response status if the kernel exposes it.
      const status = readStatus(ctx);
      requestLogger.info('request completed', {
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
 * Best-effort extraction of the response status from the context. The
 * kernel's `IResponse` is write-only, so we read from a well-known state
 * slot when a prior middleware has stored it, falling back to `0`.
 *
 * @param ctx - The request context
 * @returns The status code, or `0` if unknown
 */
function readStatus(ctx: IRequestContext): number {
  const stored = ctx.state.get('responseStatus');
  return typeof stored === 'number' ? stored : 0;
}
