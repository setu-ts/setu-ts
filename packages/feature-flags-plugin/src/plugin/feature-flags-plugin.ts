/**
 * FeatureFlagsPlugin — registers `IFeatureFlags` under `CAPABILITIES.FEATURE_FLAGS`.
 *
 * @module
 */

import type { IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { HealthCheckResult, HealthIndicatorFn } from '@hono-enterprise/common';
import type { FeatureFlagsPluginOptions, FlagProvider } from '../interfaces/index.ts';
import { ConfigProvider } from '../providers/config-provider.ts';
import { MemoryProvider } from '../providers/memory-provider.ts';
import { DatabaseProvider } from '../providers/database-provider.ts';
import { LaunchDarklyProvider } from '../providers/launchdarkly-provider.ts';
import { FeatureFlagService } from '../services/feature-flags-service.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'feature-flags-plugin';

/**
 * Creates a flag provider from plugin options.
 *
 * Dispatches on the `provider` discriminant, wiring the DB arm with
 * `ctx.runtime` and `ctx.logger`.
 *
 * @param options - Plugin options (discriminated union).
 * @param ctx - Plugin context (for `runtime` / `logger`).
 * @returns A configured `FlagProvider`.
 * @throws If the provider discriminant is unrecognized.
 */
export function createProvider(
  options: FeatureFlagsPluginOptions,
  ctx: IPluginContext,
): FlagProvider {
  switch (options.provider) {
    case 'config': {
      return new ConfigProvider(options.options.flags);
    }

    case 'memory': {
      const initialFlags = options.options?.flags;
      return new MemoryProvider(initialFlags);
    }

    case 'database': {
      // Narrowed by switch discriminant — no cast needed.
      return new DatabaseProvider(options.options, ctx.runtime, ctx.logger);
    }

    case 'launchdarkly': {
      // Narrowed by switch discriminant — no cast needed.
      return new LaunchDarklyProvider(options.options, ctx.logger);
    }

    case 'custom': {
      // Narrowed by switch discriminant — no cast needed.
      return options.options.instance;
    }

    default:
      throw new Error(
        `Unrecognized feature flags provider: ${(options as { provider: string }).provider}`,
      );
  }
}

/**
 * FeatureFlagsPlugin factory.
 *
 * Registers a `FeatureFlagService` implementing `IFeatureFlags` under
 * `CAPABILITIES.FEATURE_FLAGS`, a `feature-flags` health indicator, and an
 * `onClose` hook that stops the provider.
 *
 * @example
 * ```typescript
 * import { FeatureFlagsPlugin } from '@hono-enterprise/feature-flags-plugin';
 *
 * app.register(FeatureFlagsPlugin({
 *   provider: 'config',
 *   options: {
 *     flags: {
 *       'beta': { enabled: true },
 *     },
 *   },
 * }));
 * ```
 *
 * @param options - Plugin configuration (discriminated union).
 * @returns The plugin instance.
 * @since 0.1.0
 */
export function FeatureFlagsPlugin(options: FeatureFlagsPluginOptions): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    provides: [CAPABILITIES.FEATURE_FLAGS],
    optionalDependencies: [CAPABILITIES.LOGGER],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(options, ctx);
      const service = new FeatureFlagService(provider);

      // Await start so DB provider finishes its initial load + arms timer
      await service.start();

      // Register under the capability token
      ctx.services.register(CAPABILITIES.FEATURE_FLAGS, service);

      // Health indicator — uses the closed-over `provider` (not re-resolved)
      const indicator: HealthIndicatorFn = (): Promise<HealthCheckResult> => {
        const status = service.status();

        if (status === undefined || status.healthy === true) {
          return Promise.resolve({
            status: 'up',
            data: { provider: provider.type },
          });
        }

        // Only include detail when the custom provider actually returned one
        if (status.detail !== undefined) {
          return Promise.resolve({
            status: 'degraded',
            data: { provider: provider.type, detail: status.detail },
          });
        }

        return Promise.resolve({
          status: 'degraded',
          data: { provider: provider.type },
        });
      };

      ctx.health.register('feature-flags', indicator);

      // Lifecycle cleanup
      ctx.lifecycle.onClose(async () => {
        await service.stop();
      });
    },
  };
}
