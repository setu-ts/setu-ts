/**
 * MemoryProvider — mutable in-process flag store.
 *
 * @module
 */

import type { FlagContext } from '@setu-ts/common';
import type { FlagDefinition, FlagProvider } from '../interfaces/index.ts';
import { evaluateFlag } from '../evaluation/flag-evaluator.ts';

/**
 * Mutable in-memory flag provider.
 *
 * Flags can be added, removed, or replaced at runtime. Useful for tests and
 * dynamic flag management within a single process.
 *
 * @example
 * ```typescript
 * const provider = new MemoryProvider({
 *   'beta': { enabled: true },
 * });
 * provider.setFlag('new-feature', { enabled: false });
 * provider.removeFlag('beta');
 * provider.replaceFlags({ 'new-feature': { enabled: true } });
 * ```
 * @since 0.1.0
 */
export class MemoryProvider implements FlagProvider {
  readonly type: 'memory' = 'memory';

  private readonly _flags: Map<string, FlagDefinition>;

  constructor(initialFlags?: Readonly<Record<string, FlagDefinition>>) {
    this._flags = new Map();
    if (initialFlags) {
      for (const [key, def] of Object.entries(initialFlags)) {
        this._flags.set(key, def);
      }
    }
  }

  /**
   * Evaluates the flag against the current flag map.
   *
   * @param flag - Flag name.
   * @param context - Targeting context.
   * @returns Whether the flag is enabled.
   */
  isEnabled(flag: string, context?: FlagContext): boolean {
    const def = this._flags.get(flag);
    return evaluateFlag(flag, def, context);
  }

  /**
   * Sets or updates a flag definition.
   *
   * @param name - Flag name.
   * @param def - Flag definition.
   */
  setFlag(name: string, def: FlagDefinition): void {
    this._flags.set(name, def);
  }

  /**
   * Removes a flag by name.
   *
   * @param name - Flag name.
   */
  removeFlag(name: string): void {
    this._flags.delete(name);
  }

  /**
   * Replaces all flags with a new set.
   *
   * @param flags - New flag map.
   */
  replaceFlags(flags: Readonly<Record<string, FlagDefinition>>): void {
    this._flags.clear();
    for (const [key, def] of Object.entries(flags)) {
      this._flags.set(key, def);
    }
  }

  /** No-op — in-memory store needs no startup. */
  async start(): Promise<void> {
    // nothing to do
  }

  /** No-op — in-memory store needs no shutdown. */
  async stop(): Promise<void> {
    // nothing to do
  }
}
