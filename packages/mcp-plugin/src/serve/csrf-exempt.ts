/** In-process form-CSRF marker for the MCP transport endpoint. @module */
import type { MiddlewareFunction } from '@setu-ts/common';
import { CSRF_EXEMPT_STATE_KEY } from '@setu-ts/common';

/**
 * Marks only POST on the configured MCP path; the route enforces its Origin rule.
 * @param path - The resolved MCP endpoint path
 * @returns Middleware that sets the exemption before form CSRF runs
 * @since 0.13.0
 */
export function csrfExempt(path: string): MiddlewareFunction {
  return async (ctx, next) => {
    if (ctx.request.method === 'POST' && ctx.request.path === path) {
      ctx.state.set(CSRF_EXEMPT_STATE_KEY, true);
    }
    await next();
  };
}
