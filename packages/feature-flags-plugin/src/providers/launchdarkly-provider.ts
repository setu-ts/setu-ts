/**
 * LaunchDarkly-backed flag provider.
 *
 * @module
 * @since 0.2.0
 */

import type { FlagContext, ILogger } from '@setu-ts/common';
import type {
  FlagProvider,
  FlagProviderStatus,
  LaunchDarklyProviderConfig,
} from '../interfaces/index.ts';
import type {
  ILaunchDarklyClient,
  ILaunchDarklyFlagsState,
  LaunchDarklyContext,
} from './launchdarkly-module.ts';
import { adaptLaunchDarklyModule, loadLaunchDarklyModule } from './launchdarkly-module.ts';

/** Cache key used for a context carrying no `userId`. */
const ANONYMOUS_KEY = '__anonymous__';

/** Default wait budget, in seconds, for the client's initial connection. */
const DEFAULT_INIT_TIMEOUT_SECONDS = 5;

/**
 * Builds the LaunchDarkly evaluation context for a framework
 * {@linkcode FlagContext}.
 *
 * Exported for direct unit testing: it is the one place a framework context is
 * translated to the SDK's shape, and its anonymous fallback is what keeps a
 * context-less `isEnabled('flag')` evaluable.
 *
 * @param context - The framework targeting context
 * @returns The SDK context
 * @since 0.2.0
 */
export function toLaunchDarklyContext(context?: FlagContext): LaunchDarklyContext {
  const key = context?.userId ?? ANONYMOUS_KEY;
  const base: LaunchDarklyContext = context?.userId === undefined
    ? { kind: 'user', key, anonymous: true }
    : { kind: 'user', key };
  const attributes = context?.attributes;
  if (attributes === undefined) {
    return base;
  }
  // Targeting attributes are carried through so LaunchDarkly's own rules can
  // read them — the built-in evaluator ignores them, but this provider does not.
  return { ...base, ...attributes };
}

/**
 * Derives the cache key for a context. Only `userId` participates: LaunchDarkly
 * re-evaluates the whole snapshot per context key, and keying on attributes too
 * would make the cache unbounded for callers that vary them per request.
 *
 * @param context - The framework targeting context
 * @returns The cache key
 */
function cacheKeyFor(context?: FlagContext): string {
  return context?.userId ?? ANONYMOUS_KEY;
}

/**
 * A {@linkcode FlagProvider} backed by LaunchDarkly.
 *
 * **The synchronous/asynchronous bridge.** LaunchDarkly's server SDK evaluates
 * flags locally against a ruleset it streams into the process, but every
 * evaluation method it exposes is asynchronous, so it cannot directly satisfy
 * the committed synchronous `IFeatureFlags.isEnabled`. This provider bridges
 * the two using the one synchronous read the SDK does offer:
 * `LDFlagsState.getFlagValue`.
 *
 * - {@linkcode LaunchDarklyProvider.isEnabled} answers from a per-context
 *   snapshot cache. On a **cache miss** — the first evaluation for a given
 *   `userId` — it returns the configured `fallbackValue` and schedules a
 *   background refill, so every subsequent call for that user is answered from
 *   real LaunchDarkly state. `start()` prewarms the anonymous context, and an
 *   SDK `update` event drops the whole cache.
 * - {@linkcode LaunchDarklyProvider.isEnabledAsync} has no such caveat: it
 *   awaits `boolVariation` directly and is always correct.
 *
 * Choose the async method wherever a wrong answer on a cold context would
 * matter.
 *
 * @example
 * ```typescript
 * app.register(FeatureFlagsPlugin({
 *   provider: 'launchdarkly',
 *   options: { sdkKey: runtime.env.LD_SDK_KEY ?? '', fallbackValue: false },
 * }));
 * ```
 * @since 0.2.0
 */
export class LaunchDarklyProvider implements FlagProvider {
  readonly type = 'launchdarkly' as const;

  readonly #config: LaunchDarklyProviderConfig;
  readonly #logger: ILogger | undefined;
  readonly #fallbackValue: boolean;

  /** Per-context snapshots, keyed by `userId` (or the anonymous key). */
  readonly #snapshots = new Map<string, ILaunchDarklyFlagsState>();
  /** Context keys with a refill already in flight, so misses do not stampede. */
  readonly #refilling = new Set<string>();

  #client: ILaunchDarklyClient | undefined;
  #started = false;
  /** Set when `start()` could not reach LaunchDarkly; surfaced by `status()`. */
  #startError: string | undefined;

  /**
   * @param config - The provider configuration
   * @param logger - Optional logger for background-refill failures
   */
  constructor(config: LaunchDarklyProviderConfig, logger?: ILogger) {
    this.#config = config;
    this.#logger = logger;
    this.#fallbackValue = config.fallbackValue ?? false;
  }

  /**
   * Evaluates a flag against the cached snapshot for this context.
   *
   * @param flag - Flag name
   * @param context - Targeting context
   * @returns The snapshot value, or the configured `fallbackValue` when this
   * context has not been evaluated yet (a background refill is scheduled)
   */
  isEnabled(flag: string, context?: FlagContext): boolean {
    const key = cacheKeyFor(context);
    const snapshot = this.#snapshots.get(key);

    if (snapshot === undefined) {
      this.#scheduleRefill(key, context);
      return this.#fallbackValue;
    }

    // An unknown flag reads back as null, and a non-boolean variation is not a
    // boolean flag; the committed contract says both evaluate to `false`.
    return snapshot.getFlagValue(flag) === true;
  }

  /**
   * Evaluates a flag by awaiting LaunchDarkly directly.
   *
   * Unlike {@linkcode LaunchDarklyProvider.isEnabled} this has no cold-context
   * caveat. It also refreshes the snapshot cache, so a later synchronous read
   * for the same context is answered from real state.
   *
   * @param flag - Flag name
   * @param context - Targeting context
   * @returns The evaluated value, or the configured `fallbackValue` when the
   * client is unavailable
   */
  async isEnabledAsync(flag: string, context?: FlagContext): Promise<boolean> {
    const client = this.#client;
    if (client === undefined) {
      return this.#fallbackValue;
    }
    const ldContext = toLaunchDarklyContext(context);
    const value = await client.boolVariation(flag, ldContext, this.#fallbackValue);
    // Opportunistically warm the sync path for this context.
    this.#scheduleRefill(cacheKeyFor(context), context);
    return value;
  }

  /**
   * Builds the client (unless one was injected), waits for its initial
   * connection, subscribes to flag updates, and prewarms the anonymous
   * snapshot.
   *
   * A connection that does not complete within `initTimeoutSeconds` is logged
   * and tolerated rather than thrown: a flag backend being briefly unreachable
   * should leave the application serving with fallback values, not refuse to
   * boot. The condition is reported through
   * {@linkcode LaunchDarklyProvider.status}.
   *
   * @throws {Error} When neither a client nor an `sdkKey` was configured, or
   * when the SDK module cannot be loaded
   */
  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    // Marked started only once a client exists. Setting the flag first would
    // wedge the provider permanently when `#buildClient` throws: a retry would
    // return early, resolve successfully, and leave every evaluation stuck on
    // the fallback. The kernel follows the same rollback rule for a failed
    // application start.
    this.#client = this.#config.client ?? await this.#buildClient();
    this.#started = true;

    try {
      await this.#client.waitForInitialization({
        timeoutSeconds: this.#config.initTimeoutSeconds ?? DEFAULT_INIT_TIMEOUT_SECONDS,
      });
    } catch (error) {
      this.#startError = error instanceof Error ? error.message : String(error);
      this.#logger?.warn(
        'launchdarkly: client did not initialize; serving fallback values until it connects',
        { error: this.#startError },
      );
    }

    // Any flag change invalidates every cached snapshot: the SDK reports which
    // key changed, but a percentage rollout or segment edit can move users the
    // provider has already cached under other keys.
    this.#client.on('update', () => {
      this.#snapshots.clear();
    });

    await this.#refill(this.#client, ANONYMOUS_KEY, undefined);
  }

  /** Closes the client and drops every cached snapshot. */
  stop(): Promise<void> {
    this.#client?.close();
    this.#client = undefined;
    this.#snapshots.clear();
    this.#refilling.clear();
    this.#started = false;
    return Promise.resolve();
  }

  /**
   * Reports whether the client is connected.
   *
   * @returns `healthy: false` with a detail when the client is absent or has
   * not completed initialization
   */
  status(): FlagProviderStatus {
    const client = this.#client;
    if (client === undefined) {
      return { healthy: false, detail: 'launchdarkly client not started' };
    }
    if (!client.initialized()) {
      return {
        healthy: false,
        detail: this.#startError ?? 'launchdarkly client has not completed initialization',
      };
    }
    return { healthy: true };
  }

  /** Builds a client from the injected or lazily-imported module. */
  async #buildClient(): Promise<ILaunchDarklyClient> {
    const { sdkKey } = this.#config;
    if (sdkKey === undefined || sdkKey === '') {
      throw new Error(
        "feature-flags: the 'launchdarkly' provider requires options.sdkKey " +
          'when no options.client is injected',
      );
    }
    const module = this.#config.module === undefined
      ? await loadLaunchDarklyModule()
      : adaptLaunchDarklyModule(this.#config.module);
    return module.init(sdkKey, this.#config.ldOptions);
  }

  /**
   * Fires a background refill for a context, at most one at a time per key.
   *
   * The synchronous read path cannot await, so a miss returns the fallback and
   * leaves this running; the coalescing set is what stops a hot loop over an
   * uncached user from launching one SDK call per evaluation.
   *
   * @param key - The cache key
   * @param context - The originating framework context
   */
  #scheduleRefill(key: string, context: FlagContext | undefined): void {
    const client = this.#client;
    if (client === undefined || this.#refilling.has(key)) {
      return;
    }
    void this.#refill(client, key, context);
  }

  /**
   * Fetches and caches the snapshot for a context.
   *
   * @param client - The live client to fetch through
   * @param key - The cache key
   * @param context - The originating framework context
   */
  async #refill(
    client: ILaunchDarklyClient,
    key: string,
    context: FlagContext | undefined,
  ): Promise<void> {
    this.#refilling.add(key);
    try {
      const state = await client.allFlagsState(toLaunchDarklyContext(context));
      // An invalid snapshot means the SDK could not evaluate (offline, bad
      // context); caching it would pin every flag to the fallback until the
      // next update event.
      if (state.valid) {
        this.#snapshots.set(key, state);
      }
    } catch (error) {
      this.#logger?.warn('launchdarkly: snapshot refresh failed', {
        contextKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#refilling.delete(key);
    }
  }
}
