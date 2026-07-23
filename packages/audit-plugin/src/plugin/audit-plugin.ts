/**
 * AuditPlugin — registers an {@linkcode IAuditLogger} under
 * `CAPABILITIES.AUDIT`, backed by a pluggable storage port.
 *
 * @module
 */
import type { IPlugin, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  AuditPluginOptions,
  AuditStorageOptions,
  AuditStorageType,
  IAuditStorage,
} from '../interfaces/index.ts';
import { AuditService } from '../services/audit-service.ts';
import { MemoryAuditStorage } from '../storage/memory-audit.ts';
import { LogAuditStorage } from '../storage/log-audit.ts';
import { DatabaseAuditStorage } from '../storage/database-audit.ts';
import { FileAuditStorage } from '../storage/file-audit.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'audit-plugin';

/** Default storage backend. */
const DEFAULT_STORAGE: AuditStorageType = 'memory';

/**
 * Builds an {@linkcode IAuditStorage} for the configured backend.
 *
 * @param type - Storage backend id
 * @param options - Backend-specific options
 * @param ctx - Plugin context (for logger / fs resolution)
 * @returns The storage instance
 * @throws If an unknown storage id is provided
 */
export function createStorage(
  type: AuditStorageType,
  options: AuditStorageOptions,
  ctx: IPluginContext,
): IAuditStorage {
  switch (type) {
    case 'memory':
      return new MemoryAuditStorage();

    case 'log': {
      const storage = new LogAuditStorage();
      if (options.logger) {
        storage.setContextLogger(options.logger);
      } else if (ctx.logger) {
        storage.setContextLogger(ctx.logger);
      }
      if (!storage.isReady()) {
        throw new Error(
          'LogAuditStorage requires the logger capability; register LoggerPlugin or choose another storage',
        );
      }
      if (options.level) {
        storage.setLogLevel(options.level);
      }
      return storage;
    }

    case 'database': {
      if (!options.client) {
        throw new Error('DatabaseAuditStorage requires an injected IAuditDbClient');
      }
      const dbOpts: { client: NonNullable<AuditStorageOptions['client']>; table?: string } = {
        client: options.client,
      };
      if (options.table !== undefined) {
        dbOpts.table = options.table;
      }
      return new DatabaseAuditStorage(dbOpts);
    }

    case 'file': {
      const fs = ctx.runtime.fs;
      if (!fs) {
        throw new Error('FileAuditStorage requires runtime.fs which is absent on edge platforms');
      }
      const fileOpts: { fs: typeof fs; path?: string } = {
        fs,
      };
      if (options.path !== undefined) {
        fileOpts.path = options.path;
      }
      return new FileAuditStorage(fileOpts);
    }

    default:
      throw new Error(`Unknown audit storage type: ${type}`);
  }
}

/**
 * AuditPlugin factory — registers an `IAuditLogger` under `CAPABILITIES.AUDIT`.
 *
 * The default storage is `'memory'` (zero-dependency, non-durable). Explicitly
 * configure `'log'`, `'database'`, or `'file'` for other backends.
 *
 * @example
 * ```typescript
 * import { AuditPlugin } from '@hono-enterprise/audit-plugin';
 *
 * // Default memory backend
 * app.register(AuditPlugin());
 *
 * // Database backend (inject-only)
 * app.register(AuditPlugin({
 *   storage: 'database',
 *   options: { client: myDbClient },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 */
export function AuditPlugin(options?: AuditPluginOptions): IPlugin {
  const storageType = options?.storage ?? DEFAULT_STORAGE;
  const backendOptions: AuditStorageOptions = options?.options ?? {};

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.AUDIT],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const storage = createStorage(storageType, backendOptions, ctx);
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const service = new AuditService(storage, runtime);

      ctx.services.register<typeof service>(CAPABILITIES.AUDIT, service);

      ctx.health.register('audit', () =>
        Promise.resolve({
          status: storage.isReady() ? 'up' : 'down',
        }));

      ctx.lifecycle.onClose(() => {
        // No-op for most backends; file could flush buffers if needed.
      });
    },
  };
}
