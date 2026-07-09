// deno-lint-ignore-file require-await -- interface methods must be async (IPlugin)
/**
 * DatabasePlugin — registers an {@linkcode IDatabaseService} under
 * `CAPABILITIES.DATABASE`.
 *
 * Supports Prisma, Drizzle, and Memory adapters. The Memory adapter is
 * the default and requires zero external dependencies.
 *
 * @module
 */
import type { ILogger, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, createCapabilityToken, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  DatabaseAdapterOptions,
  DatabaseAdapterType,
  DatabasePluginOptions,
  IDatabaseService,
} from '../interfaces/index.ts';
import { createMemoryDataSource, DatabaseService } from '../services/database-service.ts';
import { MemoryAdapter } from '../adapters/memory/memory-adapter.ts';
import { PrismaAdapter } from '../adapters/prisma/prisma-adapter.ts';
import { DrizzleAdapter } from '../adapters/drizzle/drizzle-adapter.ts';
import { createPrismaDataSource } from '../adapters/prisma/prisma-repository.ts';
import { createDrizzleDataSource } from '../adapters/drizzle/drizzle-repository.ts';
import type { DataSource } from '../repositories/base-repository.ts';

/** Default adapter when none is specified. */
const DEFAULT_ADAPTER: DatabaseAdapterType = 'memory';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'database-plugin';

/**
 * Creates the DatabasePlugin.
 *
 * The plugin registers an {@linkcode IDatabaseService} under the
 * `CAPABILITIES.DATABASE` token (or `database.<name>` when a custom name
 * is provided for multi-database setups).
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@hono-enterprise/database-plugin';
 *
 * // Memory adapter (default, zero deps)
 * app.register(DatabasePlugin());
 *
 * // Prisma adapter with options
 * app.register(DatabasePlugin({
 *   type: 'prisma',
 *   options: {
 *     url: config.get('DATABASE_URL'),
 *     logQueries: true,
 *   },
 * }));
 *
 * // Named connection for multi-database
 * app.register(DatabasePlugin({
 *   type: 'prisma',
 *   name: 'analytics',
 *   options: { url: config.get('ANALYTICS_DATABASE_URL') },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function DatabasePlugin(options?: DatabasePluginOptions): IPlugin {
  const adapterType = options?.type ?? DEFAULT_ADAPTER;
  const connectionName = options?.name ?? 'default';
  const adapterOptions = buildAdapterOptions(options?.options);

  // Determine the registration token using dot-notation (colon forbidden by createCapabilityToken).
  const token = connectionName === 'default'
    ? CAPABILITIES.DATABASE
    : createCapabilityToken(`database.${connectionName}`);

  // Plugin name: default stays 'database-plugin'; named gets 'database-plugin.<name>'.
  const pluginName = connectionName === 'default'
    ? PLUGIN_NAME
    : `database-plugin.${connectionName}`;

  return {
    name: pluginName,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [token],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const logger = resolveLogger(ctx);
      const adapter = await createAdapter(adapterType, adapterOptions, logger);

      // Connect the adapter.
      await adapter.connect();

      // Build the data-source factory for the adapter type.
      const createDataSource = createDataSourceFactory(adapterType, adapter);

      const service = new DatabaseService(
        adapter,
        createDataSource,
        adapterType,
        adapterOptions,
        logger,
      );

      // Register the database service.
      ctx.services.register<IDatabaseService>(token, service);

      // Register health indicator.
      ctx.health.register(`${token}`, async () => {
        const healthy = await service.isHealthy();
        return {
          status: healthy ? 'up' : 'down',
          data: { adapter: adapterType, name: connectionName },
        };
      });

      // Register shutdown hook.
      ctx.lifecycle.onClose(async () => {
        await service.close();
      });
    },
  };
}

/**
 * Create the appropriate adapter based on the configured type.
 *
 * @param adapterType - Which ORM adapter to instantiate
 * @param adapterOptions - Adapter-specific options
 * @param logger - Optional logger for query logging
 * @returns The instantiated adapter
 * @throws {Error} If the adapter type is unsupported
 */
async function createAdapter(
  adapterType: DatabaseAdapterType,
  adapterOptions: DatabaseAdapterOptions,
  logger?: ILogger,
): Promise<import('@hono-enterprise/common').IOrmAdapter> {
  switch (adapterType) {
    case 'prisma':
      return new PrismaAdapter(adapterOptions, logger);
    case 'drizzle':
      return new DrizzleAdapter(adapterOptions);
    case 'memory':
    default:
      return new MemoryAdapter();
  }
}

/**
 * Create the data-source factory function for the given adapter type.
 *
 * @param adapterType - Which adapter is in use
 * @param adapter - The resolved adapter instance (typed for factory dispatch)
 * @returns Factory that creates a DataSource for a given entity name
 */
function createDataSourceFactory(
  adapterType: DatabaseAdapterType,
  adapter: import('@hono-enterprise/common').IOrmAdapter,
): (entity: string) => DataSource {
  switch (adapterType) {
    case 'memory': {
      const memAdapter = adapter as MemoryAdapter;
      return (entity: string) => createMemoryDataSource(memAdapter, entity);
    }
    case 'prisma': {
      const prismaAdapter = adapter as PrismaAdapter;
      return (entity: string) => createPrismaDataSource(prismaAdapter, entity);
    }
    case 'drizzle':
    default: {
      const drizzleAdapter = adapter as DrizzleAdapter;
      return (entity: string) => createDrizzleDataSource(drizzleAdapter, entity);
    }
  }
}

/**
 * Build a `DatabaseAdapterOptions` object without ever assigning `undefined`
 * to optional properties (required by `exactOptionalPropertyTypes`).
 *
 * @param opts - Raw adapter options from the plugin options
 * @returns Normalized adapter options
 */
function buildAdapterOptions(opts?: DatabaseAdapterOptions): DatabaseAdapterOptions {
  const result: Record<string, unknown> = {};
  if (opts?.url !== undefined) {
    result.url = opts.url;
  }
  if (opts?.logQueries !== undefined) {
    result.logQueries = opts.logQueries;
  }
  if (opts?.prismaClient !== undefined) {
    result.prismaClient = opts.prismaClient;
  }
  if (opts?.drizzleInstance !== undefined) {
    result.drizzleInstance = opts.drizzleInstance;
  }
  return result as DatabaseAdapterOptions;
}

/**
 * Resolve an optional logger from the plugin context.
 *
 * @param ctx - Plugin context
 * @returns The logger if available, otherwise `undefined`
 */
function resolveLogger(ctx: IPluginContext): ILogger | undefined {
  if (ctx.services.has(CAPABILITIES.LOGGER)) {
    return ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  }
  return undefined;
}
