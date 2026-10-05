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
  resolveRegistryEntry,
} from '@setu-ts/common';
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
import denoJson from '../../deno.json' with { type: 'json' };

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
    version: denoJson.version,
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

      // X18-4: the unverified-claim caveat is stated where the choice takes
      // effect, not only in the resolver's JSDoc — a warning cannot be
      // missed, a paragraph three files away can. Fires for ANY spelling that
      // puts a JwtResolver in the resolved chain (`resolver: 'jwt'`, an array
      // containing one, or a bare instance).
      if (resolvers.some((resolver) => resolver instanceof JwtResolver)) {
        ctx.logger?.warn(
          'Tenant identity is resolved from an UNVERIFIED JWT claim: a client can mint a ' +
            'token naming any tenant; acceptable only alongside authentication middleware ' +
            'which separately verifies the token',
          {
            hint: 'Pair resolver: "jwt" with AuthPlugin (or equivalent) so the token is ' +
              'verified before its tenant claim is trusted.',
          },
        );
      }

      // X18-5: a non-`column` strategy NAMES isolation that only a store whose
      // backend implements it can deliver. The shipped MemoryTenantDataStore
      // uses the strategy's label as a partition-map key — it creates no
      // schemas and no databases. The shipped DatabaseTenantDataStore bridge
      // is told the strategy and implements `'column'`, throwing for
      // `'schema'`/`'database'` (M101c, V8-8). Selecting a non-`column`
      // strategy with no store of any kind therefore warns instead of leaving
      // the isolation silently logical-only. A `RegistryFactory` (M101c, V8-8)
      // IS a store of a kind — it is resolved in `onInit` and handed the
      // strategy — so it must not fire the warning. `providedStore === undefined`
      // is exactly "no instance AND no factory".
      if (strategy.kind !== 'column' && providedStore === undefined) {
        // Name the OPTION spelling the developer writes in
        // MultiTenancyPluginOptions ('schema-per-tenant'/'database-per-tenant'),
        // not the resolved strategy kind ('schema'/'database'), so the warning
        // maps back to the `database` option they set.
        const optionSpelling = strategy.kind === 'schema'
          ? 'schema-per-tenant'
          : 'database-per-tenant';
        ctx.logger?.warn(
          `Isolation strategy '${optionSpelling}' is selected but no dataStore is injected; the shipped memory store only partitions by the strategy's label and no schema or database is created`,
          {
            strategy: strategy.kind,
            hint: 'Inject a dataStore whose backend implements the strategy, or keep ' +
              "the default 'column-per-tenant'.",
          },
        );
      }

      // Build data store. A `RegistryFactory` (M101c, V8-8) is resolved in
      // `onInit` — the first phase at which the registry holds every
      // capability (M70d) — so a store that must read a capability, such as
      // `createDatabaseTenantDataStore()` resolving `CAPABILITIES.DATABASE`,
      // works even when `DatabasePlugin` is registered after this plugin:
      // every `register()` phase completes before any `onInit`, so no
      // ordering edge is needed.
      const storeFactory = typeof providedStore === 'function' ? providedStore : undefined;
      const immediateStore = typeof providedStore === 'function'
        ? undefined
        : providedStore ?? new MemoryTenantDataStore({
          generateId: () => ctx.runtime.uuid(),
        });

      // The SAME two calls both store paths make: validate the shape, then
      // hand off isolation metadata.
      const bindStore = (store: ITenantDataStore): void => {
        assertUsableStore(store);
        if (store.useIsolation) {
          store.useIsolation(strategy);
        }
      };

      if (immediateStore !== undefined) {
        bindStore(immediateStore);
      }

      // Build multi-tenancy service. With a factory the store slot is bound
      // in `onInit`; a repository call before then throws
      // `TenantDataStoreNotReadyError` (unreachable on the HTTP path).
      const service = new MultiTenancyService({
        ...(immediateStore !== undefined && { store: immediateStore }),
        ...(options.cache?.separator != null && { separator: options.cache.separator }),
      });

      // The resolved store, once known: the immediate store, or the factory's
      // result after `onInit`. The health indicator and `onClose` read through
      // this so both arms see the same value.
      let resolvedStore: ITenantDataStore | undefined = immediateStore;

      if (storeFactory !== undefined) {
        ctx.lifecycle.onInit(() => {
          const store = resolveRegistryEntry(
            storeFactory,
            ctx.services,
            'MultiTenancyPlugin.dataStore',
          );
          bindStore(store);
          service.bindStore(store);
          // The factory is now bound: the health indicator flips from
          // `'factory'` to `'custom'`, and `onClose` closes the real store.
          resolvedStore = store;
        });
      }

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

      // Register health indicator. The `store` field reports `'factory'`
      // until the factory is bound in `onInit`, then `'custom'`; the memory
      // arm reports `'memory'` (M101c, V8-8).
      ctx.health.register('multi-tenancy', (): Promise<HealthCheckResult> =>
        Promise.resolve({
          status: 'up',
          data: {
            resolver: getResolverType(options.resolver),
            strategy: strategy.kind,
            store: resolvedStore === undefined ? 'factory' : resolvedStore === immediateStore &&
                providedStore === undefined
              ? 'memory'
              : 'custom',
          },
        }));

      // Register lifecycle close. Closes whatever store ended up bound.
      ctx.lifecycle.onClose(async () => {
        await resolvedStore?.close?.();
      });
    },
  };
}
