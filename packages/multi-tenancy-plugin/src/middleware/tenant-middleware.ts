/**
 * Tenant resolution middleware.
 *
 * @module
 */
import type {
  ILogger,
  IMultiTenancyService,
  IRequestContext,
  ITenant,
  ITenantResolver,
  MiddlewareFunction,
  NextFunction,
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
  exclude?: readonly (string | RegExp)[];
}

/**
 * The operational probes exempted by default: the paths the framework's own
 * plugins serve (health, metrics, OpenAPI) plus the interactive docs. They are
 * read from those plugins' own defaults, not copied from a register — a probe
 * carries no tenant header, so a `required` deployment would otherwise never
 * become ready. Compiled once at module load; the per-request check is a
 * membership test, never a re-parse.
 */
const DEFAULT_EXCLUDED_PATHS: readonly (string | RegExp)[] = [
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

  // The exemption list is resolved once at registration: omitted → the six
  // operational defaults; `[]` → nothing exempt; otherwise the caller's list.
  const exclude = options?.exclude ?? DEFAULT_EXCLUDED_PATHS;

  return async (ctx: IRequestContext, next: NextFunction) => {
    // Excluded paths skip the middleware body entirely — no resolver runs, no
    // tenant is stamped, and a `required` deployment does not reject them. A
    // probe carries no tenant header, so running the resolver chain for it can
    // only waste a lookup and, with the JWT resolver, emit a spurious warning.
    for (const entry of exclude) {
      if (typeof entry === 'string') {
        if (entry === ctx.request.path) {
          await next();
          return;
        }
      } else {
        // Reset `lastIndex` first: a `g`/`y`-flagged RegExp is stateful across
        // `.test` calls, and the middleware runs on every request.
        entry.lastIndex = 0;
        if (entry.test(ctx.request.path)) {
          await next();
          return;
        }
      }
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
      ctx.request.tenant = resolved;

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
