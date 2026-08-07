/**
 * Feature flags plugin interfaces and types.
 *
 * @module
 */

import type { FlagContext } from '@setu-ts/common';
import type { ILaunchDarklyClient } from '../providers/launchdarkly-module.ts';

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

/**
 * Provider identity reported by {@linkcode FlagProvider.type}, and surfaced as
 * `data.provider` by the plugin's `feature-flags` health indicator.
 *
 * Includes `'custom'` so a provider supplied through the `'custom'` options arm
 * can report its own identity honestly rather than masquerading as one of the
 * three built-ins — otherwise the health indicator would name the wrong provider.
 */
export type FlagProviderType = 'config' | 'memory' | 'database' | 'launchdarkly' | 'custom';

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
  /**
   * Optionally evaluate a flag asynchronously, when the backing source can
   * produce a more accurate answer than the cached snapshot.
   *
   * Implemented only by providers whose SDK evaluates asynchronously (the
   * LaunchDarkly provider). A provider that omits it is not deficient: the
   * service resolves {@linkcode FlagProvider.isEnabled} instead, which for a
   * purely local snapshot is already the correct answer.
   *
   * @param flag - Flag name
   * @param context - Targeting context
   * @returns The evaluated value
   * @since 0.2.0
   */
  isEnabledAsync?(flag: string, context?: FlagContext): Promise<boolean>;
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

/**
 * Configuration for the `'launchdarkly'` provider arm.
 *
 * Supply `sdkKey` for the normal path, or inject `client` (a prebuilt SDK
 * client) / `module` (the SDK module) to avoid the lazy `npm:` import — the
 * seam the provider's unit tests drive.
 *
 * @since 0.2.0
 */
export interface LaunchDarklyProviderConfig {
  /**
   * The LaunchDarkly SDK key. Required unless `client` is injected; a missing
   * key with no client throws during `register()`.
   */
  readonly sdkKey?: string;
  /**
   * A prebuilt client. When present the SDK module is never loaded and
   * `sdkKey` is not read.
   */
  readonly client?: ILaunchDarklyClient;
  /**
   * The SDK module, adapted rather than imported. Lets a test drive the whole
   * construction path without the real package installed.
   */
  readonly module?: unknown;
  /**
   * Value returned by the synchronous `isEnabled` for a context whose snapshot
   * has not loaded yet, and used as the SDK default in `isEnabledAsync`.
   * Defaults to `false`.
   */
  readonly fallbackValue?: boolean;
  /**
   * Seconds to wait for the client's initial connection. Defaults to `5`. A
   * timeout is logged and tolerated, leaving the provider degraded rather than
   * failing application startup.
   */
  readonly initTimeoutSeconds?: number;
  /** Options forwarded verbatim as the SDK `init()` second argument. */
  readonly ldOptions?: Readonly<Record<string, unknown>>;
}

/** Options for the `'launchdarkly'` provider arm. */
export interface LaunchDarklyProviderOptions {
  /** Provider type discriminant. */
  provider: 'launchdarkly';
  /** LaunchDarkly configuration. */
  options: LaunchDarklyProviderConfig;
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
  | LaunchDarklyProviderOptions
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
