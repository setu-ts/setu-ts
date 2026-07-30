/**
 * Session-backed form-CSRF middleware.
 *
 * This is the synchronizer-token strategy, and it is a different mechanism from
 * `http-security-plugin`'s stateless Origin/Referer check rather than the same
 * feature configured differently. A progressive-enhancement `<Form>` post can
 * carry a hidden field but cannot set a custom header, so it can satisfy this
 * and not that; running both is the intended arrangement.
 *
 * @module
 */
import type {
  HandlerResult,
  IRequestContext,
  MiddlewareFunction,
  NextFunction,
} from '@hono-enterprise/common';

import { CsrfTokenMismatchError } from '../errors.ts';
import type { CsrfFormOptions } from '../options.ts';
import { resolveCsrfConfig } from '../options.ts';
import { verifyWithConfig } from '../csrf/verify.ts';

/** Status returned when verification fails. */
const FORBIDDEN = 403;

/**
 * Builds the form-CSRF middleware.
 *
 * Registered by the plugin at priority 275 when the `csrf` option is present:
 * after the session loads at 260, after the cheap stateless Origin/Referer check
 * at 270, and before authentication at 300 so a forged post is rejected before
 * any credential work happens.
 *
 * On failure it answers `403` and does **not** call `next()`, so neither
 * downstream middleware nor the handler runs.
 *
 * @param options - CSRF options; the plugin passes its own `csrf` block through
 * @returns The middleware function
 * @example
 * ```typescript
 * // Registered automatically:
 * SessionPlugin({ secret, csrf: {} });
 * // Or standalone, e.g. on a test app built with `autoStart: false`:
 * app.middleware.add(csrfFormMiddleware({ headerName: 'x-csrf-token' }), { priority: 275 });
 * ```
 * @since 0.2.0
 */
export function csrfFormMiddleware(options: CsrfFormOptions = {}): MiddlewareFunction {
  // Resolved once at registration rather than per request (AI_GUIDELINES §14).
  const config = resolveCsrfConfig(options);

  return async (
    ctx: IRequestContext,
    next: NextFunction,
  ): Promise<void | HandlerResult> => {
    if (config.ignoreMethods.has(ctx.request.method.toUpperCase())) {
      await next();
      return;
    }

    try {
      await verifyWithConfig(ctx, config);
    } catch (error) {
      if (error instanceof CsrfTokenMismatchError) {
        // The reason is deliberately not echoed to the client: it would tell an
        // attacker whether the session or the token was the problem.
        return ctx.response.status(FORBIDDEN).json({
          error: 'Forbidden',
          message: 'CSRF token validation failed',
        });
      }
      throw error;
    }

    await next();
  };
}
