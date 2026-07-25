/**
 * `@hono-enterprise/feature-flags-plugin` — feature flag evaluation with
 * pluggable backends (config, memory, database) and a free-function route
 * guard.
 *
 * Registers {@linkcode IFeatureFlags} under `CAPABILITIES.FEATURE_FLAGS`.
 *
 * @module
 */

// ── Plugin factory ─────────────────────────────────────────────────────────

export { createProvider, FeatureFlagsPlugin } from './plugin/feature-flags-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

export { FeatureFlagService } from './services/feature-flags-service.ts';

// ── Providers ───────────────────────────────────────────────────────────────

export { ConfigProvider } from './providers/config-provider.ts';
export { MemoryProvider } from './providers/memory-provider.ts';
export { DatabaseProvider } from './providers/database-provider.ts';

// ── Middleware ──────────────────────────────────────────────────────────────

export { createFlagGuard } from './middleware/feature-flag-middleware.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export type {
  ConfigProviderOptions,
  CustomProviderOptions,
  DatabaseProviderOptions,
  FeatureFlagsPluginOptions,
  FlagDefinition,
  FlagGuardOptions,
  FlagProvider,
  FlagProviderStatus,
  FlagProviderType,
  IFlagStore,
  MemoryProviderOptions,
} from './interfaces/index.ts';

// ── Re-export common contracts ──────────────────────────────────────────────

export type { FlagContext, IFeatureFlags } from '@hono-enterprise/common';
