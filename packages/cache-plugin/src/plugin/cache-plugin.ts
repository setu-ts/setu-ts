/**
 * CachePlugin — registers an {@linkcode ICacheStore} under
 * `CAPABILITIES.CACHE`.
 *
 * Supports Memory, Redis, and Noop backends. The Memory backend is
 * the default and requires zero external dependencies.
 *
 * @module
 */
import type { ICacheStore, IPlugin, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import {
  CAPABILITIES,
  createCachedProbe,
  createCapabilityToken,
  PLUGIN_PRIORITY,
  resolveProbeTiming,
} from '@setu-ts/common';
import type { CachePluginOptions, CacheStoreOptions } from '../interfaces/index.ts';
import type { CacheStore } from '../stores/cache-store.ts';
import { MemoryStore } from '../stores/memory-store.ts';
import { RedisStore } from '../stores/redis-store.ts';
import { NoopStore } from '../stores/noop-store.ts';
import { CacheService } from '../services/cache-service.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Default store backend when none is specified. */
const DEFAULT_STORE = 'memory';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'cache-plugin';

/** Default key prefix when none is configured. */
const DEFAULT_PREFIX = '';

/**
 * Creates the CachePlugin.
 *
 * Registers an {@linkcode ICacheStore} under `CAPABILITIES.CACHE` (or
 * `cache.<name>` when a custom name is provided for multi-cache setups).
 *
 * @example
 * ```typescript
 * import { CachePlugin } from '@setu-ts/cache-plugin';
 *
 * // Memory store (default)
 * app.register(CachePlugin());
 *
 * // Redis store with URL
 * app.register(CachePlugin({
 *   store: 'redis',
 *   options: { url: 'redis://localhost:6379', prefix: 'myapp:' },
 * }));
 *
 * // Named cache instance
 * app.register(CachePlugin({ name: 'session', options: { maxSize: 500 } }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function CachePlugin(options?: CachePluginOptions): IPlugin {
  const storeType = options?.store ?? DEFAULT_STORE;
  const instanceName = options?.name ?? 'default';
  const storeOptions = buildStoreOptions(options?.options);

  // Derive token: default → 'cache', named → 'cache.<name>'
  const token = instanceName === 'default'
    ? CAPABILITIES.CACHE
    : createCapabilityToken(`cache.${instanceName}`);

  // Plugin name: default → 'cache-plugin', named → 'cache-plugin.<name>'
  const pluginName = instanceName === 'default' ? PLUGIN_NAME : `cache-plugin.${instanceName}`;

  return {
    name: pluginName,
    version: denoJson.version,
    optionalDependencies: ['logger'],
    provides: [token],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const prefix = storeOptions.prefix ?? DEFAULT_PREFIX;

      // Derive a runtime clock for the MemoryStore — outside packages/runtime,
      // get time via IRuntimeServices, never a bare runtime API.
      const clock = resolveClock(ctx);

      // Create the backend store.
      const backend = createBackend(storeType, prefix, storeOptions, { clock });

      // Connect the backend.
      await backend.connect();

      // Optional logger resolution.
      const logger = resolveLogger(ctx);

      if (logger) {
        logger.debug(`CachePlugin registered`, {
          store: storeType,
          token,
          prefix,
          defaultTtl: storeOptions.defaultTtl,
        });
      }

      // Wrap in CacheService (applies prefix + defaultTtl).
      const service = new CacheService(backend, prefix, storeOptions.defaultTtl);

      // Register the cache service under the derived token.
      ctx.services.register<ICacheStore>(token, service);

      // Register health indicator. M90b: reports BOTH signals. `isReady()`
      // is lifecycle (never started / shut down → `down`); the cached probe
      // is reachability (the backend answers right now). A ready backend
      // whose probe fails is `down` with `data.reachable: false`; a backend
      // that cannot probe is `up` with `data.reachable: 'unknown'` —
      // never a falsely affirmative `true`.
      const probe = buildReachabilityProbe(backend, ctx);

      ctx.health.register(`${token}`, async () => {
        if (!backend.isReady()) {
          return {
            status: 'down',
            data: { store: storeType, name: instanceName, reachable: false },
          };
        }
        if (probe === undefined) {
          return {
            status: 'up',
            data: { store: storeType, name: instanceName, reachable: 'unknown' },
          };
        }
        const reachable = await probe();
        return {
          status: reachable ? 'up' : 'down',
          data: { store: storeType, name: instanceName, reachable },
        };
      });

      // Register shutdown hook.
      ctx.lifecycle.onClose(async () => {
        await backend.disconnect();
      });
    },
  };
}

/**
 * Create the appropriate backend store based on the configured type.
 *
 * @param storeType - Which backend to instantiate
 * @param prefix - Key prefix for scoping clear() operations
 * @param options - Store-specific options
 * @returns The instantiated backend
 * @throws {Error} If the store type is unsupported
 */
function createBackend(
  storeType: string,
  prefix: string,
  options: CacheStoreOptions,
  extra?: { clock?: (() => number) | undefined },
): CacheStore {
  switch (storeType) {
    case 'redis':
      return new RedisStore(prefix, {
        url: options.url,
        client: options.client,
      });
    case 'noop':
      return new NoopStore(prefix);
    case 'memory':
    default:
      return new MemoryStore(prefix, { maxSize: options.maxSize, clock: extra?.clock });
  }
}

/**
 * Resolve a monotonic clock from the runtime service when available.
 * Returns `undefined` when the runtime is not yet registered (unit tests
 * that only provide a fake context).
 */
function resolveClock(ctx: IPluginContext): (() => number) | undefined {
  if (ctx.services.has(CAPABILITIES.RUNTIME)) {
    const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return runtime.hrtime.bind(runtime);
  }
  return undefined;
}

/**
 * Build a `CacheStoreOptions` object without ever assigning `undefined`
 * to optional properties (required by `exactOptionalPropertyTypes`).
 *
 * @param opts - Raw options from the plugin options
 * @returns Normalized store options
 */
function buildStoreOptions(opts?: CacheStoreOptions): CacheStoreOptions {
  const result: Record<string, unknown> = {};
  if (opts?.url !== undefined) {
    result.url = opts.url;
  }
  if (opts?.client !== undefined) {
    result.client = opts.client;
  }
  if (opts?.prefix !== undefined) {
    result.prefix = opts.prefix;
  }
  if (opts?.defaultTtl !== undefined) {
    result.defaultTtl = opts.defaultTtl;
  }
  if (opts?.maxSize !== undefined) {
    result.maxSize = opts.maxSize;
  }
  return result as CacheStoreOptions;
}

/**
 * Builds the cached, bounded reachability probe for a backend (M90b).
 *
 * One `createCachedProbe` closure per plugin instance, constructed at
 * registration time: it coalesces concurrent health callers into a single
 * in-flight probe, caches the outcome for a TTL, and bounds each probe with
 * a timeout, so polling `/health` never turns into backend load. The TTL is
 * measured on the runtime's monotonic clock and the timeout on the runtime's
 * own timers, both injected from `ctx.runtime` — non-optional by contract
 * (the kernel registers the runtime provider first), so the probe has no
 * ambient-clock path.
 *
 * @param backend - The connected backend store
 * @param ctx - Plugin context (runtime resolution)
 * @returns The cached probe, or `undefined` when the backend cannot probe
 */
function buildReachabilityProbe(
  backend: CacheStore,
  ctx: IPluginContext,
): (() => Promise<boolean>) | undefined {
  const isHealthy = backend.isHealthy;
  if (typeof isHealthy !== 'function') {
    return undefined;
  }
  const timing = resolveProbeTiming(ctx.runtime);
  return createCachedProbe({
    // Bound call: the store's `isHealthy` reads private state, so it must be
    // invoked on its owner.
    probe: () => isHealthy.call(backend),
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

/**
 * Resolve an optional logger from the plugin context.
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
        if (logger && typeof logger.debug === 'function') {
          logger.debug.call(logger, msg, meta);
        }
      },
    };
  }
  return undefined;
}
