/**
 * Session middleware — loads before the handler, commits after it.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction, NextFunction } from '@setu-ts/common';
import {
  respondWithError,
  SESSION_STATE_KEY,
  SESSION_TENANT_BINDING_STATE_KEY,
  tenantBindingMismatch,
} from '@setu-ts/common';

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
 * The compare runs on whichever side sees the tenant second (M101c, V8-7):
 * this middleware compares at load time, which covers every tenant resolved
 * before it (the shipped resolvers at the default priority 40); the
 * multi-tenancy middleware runs the SAME compare (`tenantBindingMismatch` in
 * `common`) right after it stamps a tenant, which covers a tenant resolved
 * after this middleware. Middleware priority therefore does not matter. The
 * seal runs only for a session that carries NO binding: a bound session is
 * never rebound, so a refusal (or a tenant written by application code inside
 * a handler) cannot re-seal the session to the tenant it was just refused
 * under.
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
    // the cross-tenant write this binding exists to stop. The short-circuit
    // answers through the request-scoped error responder, so it carries the
    // application's configured error format — the same convergence as the
    // tenant rejection in the multi-tenancy middleware (M70f). The shared
    // helper (M101c, V8-7) is the one implementation the tenant middleware's
    // second compare site calls.
    if (tenantBinding && tenantBindingMismatch(session, ctx.request.tenant?.id)) {
      respondWithError(ctx, {
        status: 403,
        title: 'Tenant Mismatch',
        detail: 'This session was created for a different tenant',
      });
      return;
    }

    ctx.state.set(SESSION_STATE_KEY, session);
    // Tell the tenant-side compare whether binding is on, so `tenantBinding:
    // false` disables BOTH compare sites in every middleware order.
    if (tenantBinding) {
      ctx.state.set(SESSION_TENANT_BINDING_STATE_KEY, true);
    }

    await next();

    // Bind on commit: seal the resolved tenant so the next request can compare.
    // Only seal a session that carries NO binding — a bound session is never
    // rebound, so a refusal or a tenant written by application code inside a
    // handler cannot re-seal the session to the tenant it was just refused
    // under (M101c, V8-7). `set` marks the session dirty, which is correct — a
    // first request under a tenant must persist the binding even if it changed
    // nothing else.
    if (tenantBinding) {
      const current = ctx.request.tenant?.id;
      if (current !== undefined && readTenantBinding(session) === undefined) {
        sealTenantBinding(session, current);
      }
    }

    await service.commit(ctx, session);
  };
}
