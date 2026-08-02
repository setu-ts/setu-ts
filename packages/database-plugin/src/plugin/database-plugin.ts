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
  CustomDatabaseOptions,
  DatabaseAdapterOptions,
  DatabaseAdapterType,
  DatabasePluginOptions,
  IDatabaseService,
} from '../interfaces/index.ts';
import { DatabaseService } from '../services/database-service.ts';
import { MemoryAdapter } from '../adapters/memory/memory-adapter.ts';
import { PrismaAdapter } from '../adapters/prisma/prisma-adapter.ts';
import { DrizzleAdapter } from '../adapters/drizzle/drizzle-adapter.ts';
import type { IDatabaseAdapter } from '@hono-enterprise/common';
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
      const adapter = await createAdapter(options, adapterType, adapterOptions);

      // Connect the adapter.
      await adapter.connect();

      // Every adapter — built-in or custom — exposes `createDataSource` on the
      // promoted port, so there is no per-type switch and no cast to a
      // concrete adapter class. That cast is what kept the seam closed.
      const createDataSource = (entity: string): DataSource => adapter.createDataSource(entity);

      // Optional logger resolution.
      const logger = resolveLogger(ctx);

      // Monotonic clock from runtime (NEVER Date.now()).
      const now = (): number => ctx.runtime.hrtime();

      const service = new DatabaseService(
        adapter,
        createDataSource,
        adapterType,
        adapterOptions,
        logger,
        now,
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
 * Create the appropriate adapter for the configured arm.
 *
 * The `'custom'` arm returns the application's own adapter verbatim — it is
 * never constructed or replaced here, only connected by the caller. That is
 * what lets a backend live in another package (`cloudflare-plugin`'s
 * `D1Adapter` is the first) without any package importing another plugin.
 *
 * @param options - The plugin options, needed to reach the custom arm's adapter
 * @param adapterType - Which adapter arm was selected
 * @param adapterOptions - Adapter-specific options for the built-in arms
 * @returns The adapter to use
 */
function createAdapter(
  options: DatabasePluginOptions | undefined,
  adapterType: DatabaseAdapterType,
  adapterOptions: DatabaseAdapterOptions,
): Promise<IDatabaseAdapter> {
  switch (adapterType) {
    case 'custom':
      // The union guarantees `adapter` is present whenever type is 'custom',
      // so this narrowing cannot fail for a type-checked caller.
      return Promise.resolve((options as CustomDatabaseOptions).adapter);
    case 'prisma':
      return Promise.resolve(new PrismaAdapter(adapterOptions));
    case 'drizzle':
      return Promise.resolve(new DrizzleAdapter(adapterOptions));
    case 'memory':
    default:
      return Promise.resolve(new MemoryAdapter());
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
  if (opts?.drizzleTables !== undefined) {
    result.drizzleTables = opts.drizzleTables;
  }
  if ((opts as Record<string, unknown>)?.transactionTimeout !== undefined) {
    result.transactionTimeout = (opts as Record<string, unknown>).transactionTimeout;
  }
  return result as DatabaseAdapterOptions;
}

/**
 * Resolve an optional logger from the plugin context.
 *
 * The call is made **on the logger**, never through a detached reference.
 * Both loggers `logger-plugin` ships (`ConsoleLogger`, `PinoLogger`) implement
 * `debug` in terms of a private `#` field, and a private field access on an
 * unbound method throws `TypeError` — so extracting `logger.debug` into a
 * local and invoking it made `logQueries: true` fail on every repository call
 * whenever a real logger was registered.
 *
 * @param ctx - Plugin context
 * @returns The logger if available, otherwise `undefined`
 */
function resolveLogger(
  ctx: IPluginContext,
): { debug(msg: string, meta?: Record<string, unknown>): void } | undefined {
  if (ctx.services.has('logger')) {
    const logger = ctx.services.get<Record<string, unknown>>('logger');
    return {
      debug: (msg: string, meta?: Record<string, unknown>): void => {
        if (typeof logger?.debug !== 'function') return;
        // Called as a member, so `this` is the logger and its private fields
        // resolve.
        (logger as unknown as ILogger).debug(msg, meta);
      },
    };
  }
  return undefined;
}
