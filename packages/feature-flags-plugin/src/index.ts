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

export { FeatureFlagsPlugin, createProvider } from './plugin/feature-flags-plugin.ts';

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
  FlagDefinition,
  FlagProvider,
  FlagProviderStatus,
  FlagProviderType,
  ConfigProviderOptions,
  MemoryProviderOptions,
  DatabaseProviderOptions,
  CustomProviderOptions,
  FeatureFlagsPluginOptions,
  FlagGuardOptions,
  IFlagStore,
} from './interfaces/index.ts';

// ── Re-export common contracts ──────────────────────────────────────────────

export type { IFeatureFlags, FlagContext } from '@hono-enterprise/common';
