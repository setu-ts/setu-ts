/**
 * Feature flag service implementing the committed `IFeatureFlags` contract.
 *
 * @module
 */

import type { FlagContext, IFeatureFlags } from '@setu-ts/common';
import type { FlagProvider, FlagProviderStatus } from '../interfaces/index.ts';

/**
 * Feature flag service that delegates to a single `FlagProvider`.
 *
 * Implements the synchronous `IFeatureFlags` contract; the provider owns a
 * cached snapshot and refreshes it out of band via its own async lifecycle.
 *
 * @example
 * ```typescript
 * const service = new FeatureFlagService(provider);
 * await service.start();
 * const on = service.isEnabled('new-dashboard', { userId: 'u1' });
 * await service.stop();
 * ```
 * @since 0.1.0
 */
export class FeatureFlagService implements IFeatureFlags {
  private readonly _provider: FlagProvider;

  constructor(provider: FlagProvider) {
    this._provider = provider;
  }

  /**
   * Evaluates whether a flag is enabled.
   *
   * @param flag - Flag name.
   * @param context - Targeting context.
   * @returns `true` when the flag is on; unknown flags → `false`.
   */
  isEnabled(flag: string, context?: FlagContext): boolean {
    return this._provider.isEnabled(flag, context);
  }

  /**
   * Evaluates a flag, awaiting the provider when it can answer asynchronously.
   *
   * Both entry points funnel through the SAME provider instance, so a
   * configured option — `fallbackValue` above all — governs identically whether
   * a caller reaches for the synchronous or the asynchronous method. A provider
   * with no async path resolves its synchronous evaluation, which for a purely
   * local snapshot is already the correct answer.
   *
   * @param flag - Flag name.
   * @param context - Targeting context.
   * @returns `true` when the flag is on; unknown flags → `false`.
   * @since 0.2.0
   */
  isEnabledAsync(flag: string, context?: FlagContext): Promise<boolean> {
    const asyncEval = this._provider.isEnabledAsync;
    if (asyncEval === undefined) {
      return Promise.resolve(this._provider.isEnabled(flag, context));
    }
    return asyncEval.call(this._provider, flag, context);
  }

  /**
   * Starts the underlying provider (pulls initial state).
   */
  async start(): Promise<void> {
    await this._provider.start();
  }

  /**
   * Stops the underlying provider (releases timers / connections).
   */
  async stop(): Promise<void> {
    await this._provider.stop();
  }

  /**
   * Forwards the provider's optional health status.
   *
   * @returns Status when the provider exposes `status()`, else `undefined`.
   */
  status(): FlagProviderStatus | undefined {
    return this._provider.status?.();
  }
}
