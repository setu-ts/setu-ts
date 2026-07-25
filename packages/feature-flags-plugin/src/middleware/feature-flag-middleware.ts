/**
 * `createFlagGuard` — free-function route guard for feature flags.
 *
 * @module
 */

import type {
  FlagContext,
  IFeatureFlags,
  IRequestContext,
  MiddlewareFunction,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { FlagGuardOptions } from '../interfaces/index.ts';

/**
 * Creates a middleware function that guards a route based on a feature flag.
 *
 * Resolves `IFeatureFlags` from the service registry per request, evaluates
 * the flag, and either calls `next()` (flag on) or short-circuits to a
 * redirect / 404 (flag off).
 *
 * When the `CAPABILITIES.FEATURE_FLAGS` capability is unregistered, the
 * registry's error propagates — the guard does not fail silently.
 *
 * @example
 * ```typescript
 * app.get('/dashboard', [
 *   createFlagGuard('new-dashboard', { fallback: '/old' }),
 *   () => c.text('New dashboard'),
 * ]);
 * ```
 *
 * @param flag - Flag name to evaluate.
 * @param options - Guard options (fallback URL, status code, context override).
 * @returns A middleware function.
 * @throws {Error} If `CAPABILITIES.FEATURE_FLAGS` is not registered.
 * @since 0.1.0
 */
export function createFlagGuard(
  flag: string,
  options?: FlagGuardOptions,
): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Resolve the flag service per-request (decouples factory from registry)
    const flags = ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);

    // Build evaluation context: explicit override > user.id > omit userId
    let context: FlagContext | undefined;
    if (options?.context !== undefined) {
      context = options.context;
    } else if (ctx.request.user?.id !== undefined) {
      context = { userId: ctx.request.user.id };
    }

    const on = flags.isEnabled(flag, context);

    if (on) {
      await next();
      return;
    }

    // Flag is off — short-circuit
    if (options?.fallback !== undefined) {
      ctx.response.redirect(options.fallback);
      return;
    }

    const statusCode = options?.statusCode ?? 404;
    ctx.response.status(statusCode);
    ctx.response.text('Not Found');
  };
}
