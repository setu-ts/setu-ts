/**
 * Multi-tenancy plugin factory.
 *
 * @module
 */
import {
  CAPABILITIES,
  type HealthCheckResult,
  type IPlugin,
  type IPluginContext,
  type ITenantResolver,
  PLUGIN_PRIORITY,
} from '@hono-enterprise/common';
import type {
  ITenantDataStore,
  ITenantIsolationStrategy,
  JwtResolverOptions,
  MultiTenancyPluginOptions,
} from '../interfaces/index.ts';
import { SubdomainResolver } from '../resolvers/subdomain-resolver.ts';
import { HeaderResolver } from '../resolvers/header-resolver.ts';
import { PathResolver } from '../resolvers/path-resolver.ts';
import { JwtResolver } from '../resolvers/jwt-resolver.ts';
import { ColumnPerTenant } from '../strategies/column-strategy.ts';
import { SchemaPerTenant } from '../strategies/schema-strategy.ts';
import { DatabasePerTenant } from '../strategies/database-strategy.ts';
import { MemoryTenantDataStore } from '../stores/memory-tenant-store.ts';
import { MultiTenancyService } from '../services/multi-tenancy-service.ts';
import { tenantMiddleware } from '../middleware/tenant-middleware.ts';

// ---------------------------------------------------------------------------
// Resolver / strategy builders
// ---------------------------------------------------------------------------

/** Build a resolver chain from the `resolver` option. */
function buildResolverChain(
  config: MultiTenancyPluginOptions['resolver'],
  subdomainOpts: { baseDomain?: string } | undefined,
  headerOpts: { name?: string } | undefined,
  pathOpts: { segment?: number } | undefined,
  jwtOpts: JwtResolverOptions | undefined,
  jwtDecode: ((token: string) => Record<string, unknown> | null) | undefined,
): ITenantResolver[] {
  if (Array.isArray(config)) return config;
  // Single resolver object (arrays handled above).
  if (typeof config === 'object' && config != null) {
    return [config] as ITenantResolver[];
  }

  const optsWithDecode = jwtDecode != null ? { ...jwtOpts, decode: jwtDecode } : jwtOpts;

  switch (config) {
    case 'subdomain':
      return [new SubdomainResolver(subdomainOpts)];
    case 'header':
      return [new HeaderResolver(headerOpts)];
    case 'path':
      return [new PathResolver(pathOpts)];
    case 'jwt': {
      if (optsWithDecode == null || optsWithDecode.decode == null) {
        throw new Error(
          'JwtResolver requires either jwt.decode in options or CAPABILITIES.JWT registered.',
        );
      }
      return [
        new JwtResolver(
          optsWithDecode as JwtResolverOptions & {
            decode: (token: string) => Record<string, unknown> | null;
          },
        ),
      ];
    }
    default:
      return [];
  }
}

/** Build the isolation strategy from the `database` option. */
function buildStrategy(
  database: MultiTenancyPluginOptions['database'],
): ITenantIsolationStrategy {
  if (database && typeof database === 'object' && 'kind' in database) {
    return database;
  }
  switch (database) {
    case 'column-per-tenant':
      return new ColumnPerTenant();
    case 'schema-per-tenant':
      return new SchemaPerTenant();
    case 'database-per-tenant':
      return new DatabasePerTenant();
    default:
      return new ColumnPerTenant();
  }
}

/** The `ITenantDataStore` methods every store must provide (`useIsolation`/`close` are optional). */
const REQUIRED_STORE_METHODS = [
  'findAll',
  'findById',
  'find',
  'create',
  'update',
  'delete',
] as const;

/**
 * Validate an injected data store's shape at registration time.
 *
 * A store is an injection seam, so a wrong shape otherwise registers cleanly
 * and only fails per request (`this.store.create is not a function`) — long
 * after the misconfiguration was introduced.
 *
 * @throws {Error} When a required `ITenantDataStore` method is missing
 */
function assertUsableStore(store: ITenantDataStore): void {
  const missing = REQUIRED_STORE_METHODS.filter(
    (method) => typeof store[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `MultiTenancyPlugin: the injected dataStore is missing required ITenantDataStore ` +
        `method(s): ${missing.join(', ')}.`,
    );
  }
}

/** Determine the health-indicator resolver type name. */
function getResolverType(resolverConfig: MultiTenancyPluginOptions['resolver']): string {
  if (Array.isArray(resolverConfig)) return 'chain';
  if (typeof resolverConfig === 'object') {
    return resolverConfig.constructor.name.toLowerCase().replace('resolver', '');
  }
  return resolverConfig;
}

/**
 * Multi-tenancy plugin factory.
 *
 * Registers `IMultiTenancyService` under `CAPABILITIES.MULTI_TENANCY`,
 * auto-adds the tenant middleware at priority 40, and registers a
 * health indicator + lifecycle close.
 */
export function MultiTenancyPlugin(
  options: MultiTenancyPluginOptions,
): IPlugin {
  const {
    dataStore: providedStore,
    database = 'column-per-tenant',
    middlewarePriority = 40,
    jwt,
    subdomain,
    header,
    path,
  } = options;

  return {
    name: 'multi-tenancy-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.MULTI_TENANCY],
    optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.JWT],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext) {
      // Resolve JWT decode function if needed.
      let jwtDecode: ((token: string) => Record<string, unknown> | null) | undefined;
      const isJwtMode = options.resolver === 'jwt' || (
        Array.isArray(options.resolver) &&
        options.resolver.some((r) => r instanceof JwtResolver)
      );

      if (isJwtMode && jwt?.decode == null) {
        if (ctx.services.has(CAPABILITIES.JWT)) {
          const jwtService = ctx.services.get(CAPABILITIES.JWT) as {
            decode: (token: string) => unknown | null;
          };
          if (jwtService && typeof jwtService.decode === 'function') {
            jwtDecode = (token: string) =>
              jwtService.decode(token) as Record<string, unknown> | null;
          }
        } else if (!jwt?.decode) {
          // Only fail fast when jwt resolver is configured but no decode available.
          const needsJwtDecode = options.resolver === 'jwt';
          if (needsJwtDecode) {
            throw new Error(
              'JwtResolver requires either jwt.decode in options or CAPABILITIES.JWT registered.',
            );
          }
        }
      }

      // Build resolver chain.
      const resolvers = buildResolverChain(
        options.resolver,
        subdomain,
        header,
        path,
        jwt,
        jwtDecode,
      );

      // An empty chain resolves no tenant for any request, forever — reject it
      // at startup rather than 400-ing (or silently degrading) every request.
      if (resolvers.length === 0) {
        throw new Error(
          'MultiTenancyPlugin: the `resolver` option produced an empty resolver chain; ' +
            'configure at least one resolver.',
        );
      }

      // Build isolation strategy.
      const strategy = buildStrategy(database);

      // Build data store.
      const store = providedStore ?? new MemoryTenantDataStore({
        generateId: () => ctx.runtime.uuid(),
      });
      assertUsableStore(store);

      // Hand off isolation metadata.
      if (store.useIsolation) {
        store.useIsolation(strategy);
      }

      // Build multi-tenancy service.
      const service = new MultiTenancyService({
        store,
        ...(options.cache?.separator != null && { separator: options.cache.separator }),
      });

      // Register the service.
      ctx.services.register(CAPABILITIES.MULTI_TENANCY, service);

      // Auto-add middleware.
      const logger = ctx.logger;
      ctx.middleware.add(
        tenantMiddleware({
          service,
          resolvers,
          options,
          ...(logger != null && { logger }),
        }),
        { priority: middlewarePriority, name: 'tenant' },
      );

      // Determine store type for health indicator.
      const storeType: 'custom' | 'memory' = providedStore ? 'custom' : 'memory';

      // Register health indicator.
      ctx.health.register('multi-tenancy', (): Promise<HealthCheckResult> =>
        Promise.resolve({
          status: 'up',
          data: {
            resolver: getResolverType(options.resolver),
            strategy: strategy.kind,
            store: storeType,
          },
        }));

      // Register lifecycle close.
      ctx.lifecycle.onClose(async () => {
        await store.close?.();
      });
    },
  };
}
