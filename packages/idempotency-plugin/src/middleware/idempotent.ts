/**
 * The free-function HTTP entry point and the derived-key reader (plan §3.9,
 * §3.12).
 *
 * @module
 */
import type {
  IdempotentRouteOptions,
  IIdempotencyService,
  ILogger,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { IDEMPOTENCY_DERIVED_KEY_STATE_KEY } from '../constants.ts';
import { validateRouteOptionShape } from '../core/options.ts';
import { IdempotencyConfigurationError } from '../errors.ts';
import { safeLog } from '../core/safe-log.ts';

/**
 * Returns the derived store key the middleware recorded for this request, when
 * one was recorded. Stable across retries of the same key by the same principal
 * on the same namespace; hand it to a provider that de-duplicates.
 *
 * @param ctx - The request context
 * @returns The derived store key, or `undefined`
 * @since 0.9.0
 */
export function derivedIdempotencyKey(ctx: IRequestContext): string | undefined {
  const value = ctx.state.get(IDEMPOTENCY_DERIVED_KEY_STATE_KEY);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Builds the HTTP idempotency middleware for a functional (non-decorator)
 * route's `middleware` array. List it LAST — after guards and validation.
 *
 * @param options - The route's idempotency options
 * @returns The middleware
 * @throws {IdempotencyConfigurationError} When an option's shape is invalid
 * @since 0.9.0
 */
export function idempotent(options?: IdempotentRouteOptions): MiddlewareFunction {
  validateRouteOptionShape(options ?? {});
  // Per-call cache: middleware is built once per resolved service, and a
  // resolution error is logged once and cached. Never module-level.
  const cache = new WeakMap<
    IIdempotencyService,
    MiddlewareFunction | IdempotencyConfigurationError
  >();
  return (ctx, next) => {
    if (!ctx.services.has(CAPABILITIES.IDEMPOTENCY)) {
      // A REJECTION, never a synchronous throw: this member's declared return
      // type includes a promise, and a caller writing `.catch(...)` must see it.
      return Promise.reject(
        new IdempotencyConfigurationError(
          'idempotent()',
          'idempotent(): no CAPABILITIES.IDEMPOTENCY provider is registered — add IdempotencyPlugin() to the application',
        ),
      );
    }
    const service = ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
    let cached = cache.get(service);
    if (cached === undefined) {
      try {
        cached = service.middleware(options);
      } catch (error) {
        if (error instanceof IdempotencyConfigurationError) {
          cache.set(service, error);
          // Through safeLog, so a throwing logger can neither replace the
          // configuration error nor turn this rejection into a synchronous
          // throw (M109a audit round 4).
          safeLog(
            () =>
              ctx.services.has(CAPABILITIES.LOGGER)
                ? ctx.services.get<ILogger>(CAPABILITIES.LOGGER)
                : undefined,
            'error',
            'idempotent(): middleware configuration failed',
            { error: error.message },
          );
        }
        return Promise.reject(error);
      }
      cache.set(service, cached);
    }
    if (cached instanceof IdempotencyConfigurationError) return Promise.reject(cached);
    return cached(ctx, next);
  };
}
