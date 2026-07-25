/**
 * Feature flag service implementing the committed `IFeatureFlags` contract.
 *
 * @module
 */

import type { FlagContext, IFeatureFlags } from '@hono-enterprise/common';
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
