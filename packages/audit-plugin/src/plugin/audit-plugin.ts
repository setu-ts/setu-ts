/**
 * AuditPlugin — registers an {@linkcode IAuditLogger} under
 * `CAPABILITIES.AUDIT`, backed by a pluggable storage port.
 *
 * @module
 */
import type { HealthCheckResult, IPlugin, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import {
  CAPABILITIES,
  createCachedProbe,
  PLUGIN_PRIORITY,
  resolveProbeTiming,
} from '@setu-ts/common';
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
import denoJson from '../../deno.json' with { type: 'json' };

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
 * import { AuditPlugin } from '@setu-ts/audit-plugin';
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
    version: denoJson.version,
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.AUDIT],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const storage = createStorage(storageType, backendOptions, ctx);
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const service = new AuditService(storage, runtime);

      ctx.services.register<typeof service>(CAPABILITIES.AUDIT, service);

      // H-70c-1: this reported `storage.isReady()` alone, which is a constant
      // `true` for three of the four backends — so the indicator was in
      // practice a literal `up`, and an audit sink that was configured but
      // unreachable still read healthy while every record was being lost.
      // It now reports BOTH signals: `isReady()` is lifecycle, the cached
      // probe is reachability. A ready backend whose sink does not answer is
      // `down`; a backend that cannot probe is `up` with
      // `reachable: 'unknown'`, never a falsely affirmative `true`.
      ctx.health.register('audit', createAuditIndicator(storage, storageType, ctx));

      ctx.lifecycle.onClose(() => storage.close());
    },
  };
}

/**
 * Builds the `audit` health indicator over a storage backend.
 *
 * An internal seam rather than an inline closure, so both of its refusal arms
 * can be driven directly. Through the plugin's own factory neither is
 * reachable — every backend `createStorage` builds implements `isHealthy`,
 * and each one's `isReady()` is a constant `true` once constructed (the log
 * backend's logger is asserted at construction) — but `IAuditStorage`
 * declares both members as contract, and an indicator that ignored a port
 * member because today's four implementations happen not to exercise it is
 * how the next backend ships broken.
 *
 * @param storage - The configured storage backend
 * @param storageType - The configured backend's name, reported in the payload
 * @param ctx - Plugin context, for runtime clock and timers
 * @returns The indicator
 * @since 0.6.0
 */
export function createAuditIndicator(
  storage: IAuditStorage,
  storageType: AuditStorageType,
  ctx: IPluginContext,
): () => Promise<HealthCheckResult> {
  // H-70c-1: this reported `storage.isReady()` alone, which is a constant
  // `true` for three of the four backends — so the indicator was in practice a
  // literal `up`, and an audit sink that was configured but unreachable still
  // read healthy while every record was being lost. It now reports BOTH
  // signals: `isReady()` is lifecycle, the cached probe is reachability. A
  // ready backend whose sink does not answer is `down`; a backend that cannot
  // probe is `up` with `reachable: 'unknown'`, never a falsely affirmative
  // `true`.
  const probe = buildReachabilityProbe(storage, ctx);

  return async (): Promise<HealthCheckResult> => {
    if (!storage.isReady()) {
      return { status: 'down', data: { storage: storageType, reachable: false } };
    }
    const reachable = probe === undefined ? undefined : await probe();
    if (reachable === undefined) {
      return { status: 'up', data: { storage: storageType, reachable: 'unknown' } };
    }
    return {
      status: reachable ? 'up' : 'down',
      data: { storage: storageType, reachable },
    };
  };
}

/**
 * Builds the cached, bounded reachability probe for the configured backend.
 *
 * One closure per plugin instance, constructed at registration: it coalesces
 * concurrent health callers into a single in-flight probe, caches the outcome
 * for a TTL, and bounds each probe with a timeout, so scraping `/health` never
 * turns into sink load. The TTL runs on the runtime's monotonic clock and the
 * timeout on the runtime's timers, both injected from `ctx.runtime` — the
 * probe has no ambient-clock path.
 *
 * @param storage - The configured storage backend
 * @param ctx - Plugin context, for runtime clock and timers
 * @returns The cached probe, or `undefined` when the backend cannot probe
 * @since 0.6.0
 */
function buildReachabilityProbe(
  storage: IAuditStorage,
  ctx: IPluginContext,
): (() => Promise<boolean | undefined>) | undefined {
  const isHealthy = storage.isHealthy;
  if (typeof isHealthy !== 'function') {
    return undefined;
  }
  const timing = resolveProbeTiming(ctx.runtime);
  return createCachedProbe<boolean | undefined>({
    // Bound call: a backend's `isHealthy` reads its own private state, so it
    // must be invoked on its owner.
    probe: () => isHealthy.call(storage),
    // A probe that times out or rejects means the sink was reached for and
    // did not answer, which is `false`. `undefined` is reserved for "no probe
    // exists", decided above without calling anything.
    fallback: false,
    ttlMs: PROBE_TTL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    hrtime: timing.hrtime,
    setTimer: timing.setTimer,
    clearTimer: timing.clearTimer,
  });
}

/** Reachability outcome cache lifetime, in milliseconds. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout, in milliseconds. A slower probe counts as unreachable. */
const PROBE_TIMEOUT_MS = 2000;
