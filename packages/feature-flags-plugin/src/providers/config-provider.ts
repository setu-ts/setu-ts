/**
 * ConfigProvider — immutable inline flag definitions.
 *
 * @module
 */

import type { FlagContext } from '@setu-ts/common';
import type { FlagDefinition, FlagProvider } from '../interfaces/index.ts';
import { evaluateFlag } from '../evaluation/flag-evaluator.ts';

/**
 * Immutable config-backed flag provider.
 *
 * Flags are set at construction time and never change. Useful for simple,
 * static flag sets defined in application configuration.
 *
 * @example
 * ```typescript
 * const provider = new ConfigProvider({
 *   'beta-features': { enabled: false, users: ['user1'] },
 *   'new-dashboard': { enabled: true },
 * });
 * ```
 * @since 0.1.0
 */
export class ConfigProvider implements FlagProvider {
  readonly type: 'config' = 'config';

  private readonly _flags: Readonly<Record<string, FlagDefinition>>;

  constructor(flags: Readonly<Record<string, FlagDefinition>>) {
    this._flags = flags;
  }

  /**
   * Evaluates the flag against the immutable flag map.
   *
   * @param flag - Flag name.
   * @param context - Targeting context.
   * @returns Whether the flag is enabled.
   */
  isEnabled(flag: string, context?: FlagContext): boolean {
    return evaluateFlag(flag, this._flags[flag], context);
  }

  /** No-op — flags are immutable. */
  async start(): Promise<void> {
    // nothing to do
  }

  /** No-op — flags are immutable. */
  async stop(): Promise<void> {
    // nothing to do
  }
}
