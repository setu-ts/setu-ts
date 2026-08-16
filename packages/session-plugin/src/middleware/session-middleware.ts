/**
 * Session middleware — loads before the handler, commits after it.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction, NextFunction } from '@setu-ts/common';

import { SESSION_STATE_KEY } from '../services/session-service.ts';
import type { SessionService } from '../services/session-service.ts';
import { readTenantBinding, sealTenantBinding } from '../services/session-tenant-binding.ts';

/**
 * Builds the session middleware.
 *
 * Registered by the plugin at priority 260: after security headers (250) so a
 * rejected request never loads a session, and before authentication (300) so an
 * auth strategy can read one.
 *
 * The commit runs after `next()` returns. That works even though the handler has
 * already called a terminal response method, because the kernel's response
 * builder appends headers without consulting whether it ended, and hands the
 * adapter its live `Headers` rather than a clone — cloning would collapse
 * repeated `Set-Cookie` values into one comma-joined header.
 *
 * A request that throws is deliberately **not** committed: the error handler is
 * about to replace the response, and persisting a half-applied mutation from a
 * failed request is worse than dropping it.
 *
 * Tenant binding (default on): when a tenant is resolved for the request, the
 * session is sealed with that tenant id before it commits, and a later request
 * that presents a session bound to a different tenant is refused with `403`
 * before the handler runs. When either the session or the request carries no
 * tenant, nothing is compared, so an application without tenancy is inert.
 *
 * @param service - The session service to load and commit through
 * @param tenantBinding - Whether to bind the session to its tenant (default `true`)
 * @returns The middleware function
 * @since 0.2.0
 */
export function sessionMiddleware(
  service: SessionService,
  tenantBinding: boolean = true,
): MiddlewareFunction {
  return async (ctx: IRequestContext, next: NextFunction): Promise<void> => {
    const session = await service.load(ctx);

    // Compare on load: a session bound to tenant A presented under tenant B is
    // the cross-tenant write this binding exists to stop. The short-circuit is
    // deliberately the same `{ error, message }` shape as the tenant rejection
    // in the multi-tenancy middleware — no plugin may import
    // `@setu-ts/exceptions`, so an `HttpError` is unavailable here, and M70f
    // converges the two shapes in one place.
    if (tenantBinding) {
      const bound = readTenantBinding(session);
      const current = ctx.request.tenant?.id;
      if (bound !== undefined && current !== undefined && bound !== current) {
        ctx.response.status(403).json({
          error: 'Tenant Mismatch',
          message: 'This session was created for a different tenant',
        });
        return;
      }
    }

    ctx.state.set(SESSION_STATE_KEY, session);

    await next();

    // Bind on commit: seal the resolved tenant so the next request can compare.
    // Only seal when the binding is absent or differs, so a session already
    // bound to the current tenant is not re-written on every read-only request.
    // `set` marks the session dirty, which is correct — a first request under a
    // tenant must persist the binding even if it changed nothing else.
    if (tenantBinding) {
      const current = ctx.request.tenant?.id;
      if (current !== undefined && readTenantBinding(session) !== current) {
        sealTenantBinding(session, current);
      }
    }

    await service.commit(ctx, session);
  };
}
