/**
 * Tenant resolution middleware.
 *
 * @module
 */
import type {
  ILogger,
  IMultiTenancyService,
  IRequestContext,
  ISession,
  ITenant,
  ITenantResolver,
  MiddlewareFunction,
  NextFunction,
  PathPattern,
} from '@setu-ts/common';
import {
  createPathMatcher,
  replaceTenant,
  respondWithError,
  SESSION_STATE_KEY,
  SESSION_TENANT_BINDING_STATE_KEY,
  tenantBindingMismatch,
} from '@setu-ts/common';

/**
 * State key for the cache prefix — consumers should use `getTenantCachePrefix`
 * instead of reading this directly.
 */
export const TENANT_CACHE_PREFIX_STATE_KEY = 'multi-tenancy-plugin:cache-prefix';

/**
 * Exported accessor that reads the cache-prefix stamped into `ctx.state` by
 * the middleware. Consumers never hardcode the state key string.
 *
 * @param ctx - Must expose a `state: Map<string, unknown>` (satisfied by `IRequestContext`).
 * @returns The prefixed cache key, or `undefined` when not configured.
 */
export function getTenantCachePrefix(
  ctx: { state: Map<string, unknown> },
): string | undefined {
  const raw = ctx.state.get(TENANT_CACHE_PREFIX_STATE_KEY);
  return typeof raw === 'string' ? raw : undefined;
}

/** Partial options accepted by `tenantMiddleware` — not all fields are required. */
interface MiddlewareOptionsPartial {
  cache?: { prefix?: boolean; separator?: string };
  required?: boolean;
  rejectionStatus?: number;
  exclude?: readonly PathPattern[];
}

/**
 * The operational probes exempted by default: the paths the framework's own
 * plugins serve (health, metrics, OpenAPI) plus the interactive docs. They are
 * read from those plugins' own defaults, not copied from a register — a probe
 * carries no tenant header, so a `required` deployment would otherwise never
 * become ready. Compiled once at module load; the per-request check is a
 * membership test, never a re-parse.
 */
const DEFAULT_EXCLUDED_PATHS: readonly PathPattern[] = [
  '/live',
  '/ready',
  '/health',
  '/metrics',
  '/openapi.json',
  '/docs',
];

/** Options accepted by `tenantMiddleware`. */
interface TenantMiddlewareOptions {
  service: IMultiTenancyService;
  resolvers: readonly ITenantResolver[];
  options?: MiddlewareOptionsPartial;
  logger?: ILogger;
}

/**
 * Factory that creates a middleware function resolving the tenant and attaching
 * it to `ctx.request.tenant`.
 *
 * On successful resolution: calls `next()`.
 * When `required: true` and no tenant resolves: short-circuits with a 400
 * (or `rejectionStatus`) without calling `next()`, written through the error
 * responder seam (`respondWithError` in `@setu-ts/common`) so it answers in the
 * application's configured format when `errorHandler` is registered, and in the
 * no-handler fallback shape `{ error, detail? }` otherwise.
 * When `required: false` and no tenant resolves: proceeds with
 * `ctx.request.tenant === undefined`.
 *
 * A throwing resolver is caught, warned (when logger is present), treated as
 * `none()`, and the chain continues to the next resolver.
 */
export function tenantMiddleware({
  service,
  resolvers,
  options,
  logger,
}: TenantMiddlewareOptions): MiddlewareFunction {
  const required = options?.required ?? false;
  const rejectionStatus = options?.rejectionStatus ?? 400;
  const cacheConfig = options?.cache;

  // The exemption list is resolved and PARTITIONED once at registration:
  // omitted → the six operational defaults; `[]` → nothing exempt; otherwise
  // the caller's list. `createPathMatcher` replaces the per-request `typeof`
  // loop this middleware used to run, and owns the `lastIndex` reset a
  // `g`/`y`-flagged pattern needs (see `@setu-ts/common`).
  const isExcluded = createPathMatcher(options?.exclude ?? DEFAULT_EXCLUDED_PATHS);

  return async (ctx: IRequestContext, next: NextFunction) => {
    // Excluded paths skip the middleware body entirely — no resolver runs, no
    // tenant is stamped, and a `required` deployment does not reject them. A
    // probe carries no tenant header, so running the resolver chain for it can
    // only waste a lookup and, with the JWT resolver, emit a spurious warning.
    if (isExcluded(ctx.request.path)) {
      await next();
      return;
    }

    // Resolve tenant by chaining resolvers; first `Some` wins.
    let resolved: ITenant | undefined;

    for (let i = 0; i < resolvers.length; i++) {
      const resolver = resolvers[i];
      try {
        const result = await resolver.resolve(ctx.request);
        if (result.present) {
          resolved = result.value;
          break;
        }
      } catch (err) {
        // Throwing resolver → warn + treat as none → continue chain.
        if (logger) {
          logger.warn(
            `Tenant resolver at index ${i} threw, treating as none`,
            { error: String(err) },
          );
        }
      }
    }

    if (resolved) {
      replaceTenant(ctx.request, resolved);

      // Tenant-binding compare on the tenant side (M101c, V8-7): the session
      // middleware compares at load time, which covers a tenant resolved
      // BEFORE it; this site covers a tenant resolved AFTER it (a custom
      // resolver at a higher priority, application code). It reads the
      // session the session middleware parked in `ctx.state` — present only
      // when the session loaded first — and runs the SAME shared compare
      // (`tenantBindingMismatch` in `common`). `ISessionService.from` is not a
      // probe here: it throws when the session has not loaded, and a
      // throw-and-catch per request at priority 40 is not a probe. A
      // mismatch short-circuits with the identical `403 Tenant Mismatch` the
      // session middleware answers, without calling `next()`, so the handler
      // never runs under the mismatched session. It compares only when the
      // session middleware published that binding is ON, so
      // `SessionPlugin({ tenantBinding: false })` disables this site too.
      const parked = ctx.state.get(SESSION_STATE_KEY);
      if (
        ctx.state.get(SESSION_TENANT_BINDING_STATE_KEY) === true &&
        typeof parked === 'object' && parked !== null &&
        tenantBindingMismatch(parked as ISession, resolved.id)
      ) {
        respondWithError(ctx, {
          status: 403,
          title: 'Tenant Mismatch',
          detail: 'This session was created for a different tenant',
        });
        return;
      }

      // Stamp cache prefix into ctx.state when configured.
      if (cacheConfig?.prefix) {
        const prefix = service.prefixCacheKey(resolved.id, '');
        ctx.state.set(TENANT_CACHE_PREFIX_STATE_KEY, prefix);
      }

      await next();
      return;
    }

    // No tenant resolved.
    if (required) {
      respondWithError(ctx, {
        status: rejectionStatus,
        title: 'Tenant Required',
        detail: 'No tenant could be resolved for this request',
      });
      return;
    }

    // Not required — proceed with tenant = undefined.
    await next();
  };
}
