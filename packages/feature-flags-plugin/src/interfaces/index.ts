/**
 * Feature flags plugin interfaces and types.
 *
 * @module
 */

import type { FlagContext } from '@hono-enterprise/common';

// ── Flag definition ────────────────────────────────────────────────────────

/**
 * Definition of a single feature flag.
 *
 * @since 0.1.0
 */
export interface FlagDefinition {
  /** Whether the flag is enabled by default. */
  readonly enabled: boolean;
  /** Optional percentage rollout (0-100). */
  readonly percentage?: number;
  /** Optional user allowlist — overrides `enabled: false`. */
  readonly users?: readonly string[];
}

// ── Flag provider port ─────────────────────────────────────────────────────

/** Concrete provider type identifier. */
export type FlagProviderType = 'config' | 'memory' | 'database';

/** Status reported by a flag provider. */
export interface FlagProviderStatus {
  /** Whether the provider is healthy. */
  readonly healthy: boolean;
  /** Optional human-readable detail. */
  readonly detail?: string;
}

/**
 * Port that all flag providers implement.
 *
 * Providers refresh their state out of band; `isEnabled` evaluates against
 * a cached snapshot synchronously.
 *
 * @since 0.1.0
 */
export interface FlagProvider {
  /** Provider type identifier. */
  readonly type: FlagProviderType;
  /** Evaluate whether a flag is enabled. */
  isEnabled(flag: string, context?: FlagContext): boolean;
  /** Pull initial state into the cache. */
  start(): Promise<void>;
  /** Release timers / connections. */
  stop(): Promise<void>;
  /** Optional status — absent when the provider has no health signal. */
  status?(): FlagProviderStatus;
}

// ── Database provider ──────────────────────────────────────────────────────

/**
 * Structural facade injected into `DatabaseProvider`.
 *
 * @since 0.1.0
 */
export interface IFlagStore {
  /** Load the current flag definitions from the backing store. */
  loadFlags(): Promise<Readonly<Record<string, FlagDefinition>>>;
}

// ── Plugin options ─────────────────────────────────────────────────────────

/** Options for the `'config'` provider arm. */
export interface ConfigProviderOptions {
  /** Provider type discriminant. */
  provider: 'config';
  /** Static flag map. */
  options: { readonly flags: Readonly<Record<string, FlagDefinition>> };
}

/** Options for the `'memory'` provider arm. */
export interface MemoryProviderOptions {
  /** Provider type discriminant. */
  provider: 'memory';
  /** Optional initial flag map — defaults to empty. */
  options?: { readonly flags?: Readonly<Record<string, FlagDefinition>> };
}

/** Options for the `'database'` provider arm. */
export interface DatabaseProviderOptions {
  /** Provider type discriminant. */
  provider: 'database';
  /** Injected flag store. */
  options: {
    readonly store: IFlagStore;
    readonly refreshIntervalMs?: number;
  };
}

/** Options for the `'custom'` provider arm. */
export interface CustomProviderOptions {
  /** Provider type discriminant. */
  provider: 'custom';
  /** A pre-built `FlagProvider` instance. */
  options: { readonly instance: FlagProvider };
}

/**
 * Discriminated union of all plugin option shapes.
 *
 * @since 0.1.0
 */
export type FeatureFlagsPluginOptions =
  | ConfigProviderOptions
  | MemoryProviderOptions
  | DatabaseProviderOptions
  | CustomProviderOptions;

/**
 * Options for the `createFlagGuard` factory.
 *
 * @since 0.1.0
 */
export interface FlagGuardOptions {
  /** Fallback URL for a 302 redirect when the flag is off. */
  fallback?: string;
  /** HTTP status code when no fallback is provided (default 404). */
  statusCode?: number;
  /** Static context override for the flag evaluation. */
  context?: FlagContext;
}
