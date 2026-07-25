// deno-lint-ignore-file no-unused-vars require-await
/**
 * Tenant resolution middleware.
 *
 * @module
 */
import type {
  ILogger,
  IMultiTenancyService,
  IRequestContext,
  ITenantResolver,
  MiddlewareFunction,
  NextFunction,
} from '@hono-enterprise/common';
import type { MultiTenancyPluginOptions } from '../interfaces/index.ts';

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
}

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
 * JSON body `{ error, message }` without calling `next()`.
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
  const separator = cacheConfig?.separator;

  return async (ctx: IRequestContext, next: NextFunction) => {
    // Resolve tenant by chaining resolvers; first `Some` wins.
    let resolved: import('@hono-enterprise/common').ITenant | undefined;

    for (const resolver of resolvers) {
      try {
        const result = await resolver.resolve(ctx.request);
        if (result.present) {
          resolved = result.value;
          break;
        }
      } catch (err) {
        // Throwing resolver → warn + treat as none → continue chain.
        if (logger) {
          logger.warn('Tenant resolver threw, treating as none', { error: String(err) });
        }
      }
    }

    if (resolved) {
      ctx.request.tenant = resolved;

      // Stamp cache prefix into ctx.state when configured.
      if (cacheConfig?.prefix) {
        const prefix = service.prefixCacheKey(resolved.id, '', separator);
        ctx.state.set(TENANT_CACHE_PREFIX_STATE_KEY, prefix);
      }

      await next();
      return;
    }

    // No tenant resolved.
    if (required) {
      ctx.response.status(rejectionStatus).json({
        error: 'Tenant Required',
        message: 'No tenant could be resolved for this request',
      });
      return;
    }

    // Not required — proceed with tenant = undefined.
    await next();
  };
}
