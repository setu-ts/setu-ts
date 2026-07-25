/**
 * DatabaseProvider — polls an injected `IFlagStore` on a timer.
 *
 * @module
 */

import type { FlagContext, ILogger, IRuntimeServices } from '@hono-enterprise/common';
import type {
  FlagDefinition,
  FlagProvider,
  FlagProviderStatus,
  IFlagStore,
} from '../interfaces/index.ts';
import { evaluateFlag } from '../evaluation/flag-evaluator.ts';

interface PollTimer {
  readonly handle: unknown;
}

/**
 * Database-backed flag provider that polls an injected `IFlagStore`.
 *
 * Loads initial state via `store.loadFlags()` on `start()`, then polls at
 * a configurable interval. On poll failure, keeps the last good snapshot,
 * logs via the injected logger, and exposes unhealthy `status()`.
 *
 * @example
 * ```typescript
 * const provider = new DatabaseProvider(
 *   { store: myFlagStore, refreshIntervalMs: 60000 },
 *   ctx.runtime,
 *   ctx.logger,
 * );
 * await provider.start();
 * ```
 * @since 0.1.0
 */
export class DatabaseProvider implements FlagProvider {
  readonly type: 'database' = 'database';

  private readonly _store: IFlagStore;
  private readonly _runtime: IRuntimeServices;
  private readonly _logger: ILogger | undefined;
  private readonly _refreshIntervalMs: number;

  private _snapshot: Readonly<Record<string, FlagDefinition>> = {};
  private _lastError: string | undefined;
  private _timer: PollTimer | undefined;

  constructor(
    options: { readonly store: IFlagStore; readonly refreshIntervalMs?: number },
    runtime: IRuntimeServices,
    logger?: ILogger,
  ) {
    this._store = options.store;
    this._runtime = runtime;
    this._logger = logger;
    this._refreshIntervalMs = options.refreshIntervalMs ?? 30000;
  }

  /**
   * Evaluates the flag against the current snapshot.
   *
   * @param flag - Flag name.
   * @param context - Targeting context.
   * @returns Whether the flag is enabled.
   */
  isEnabled(flag: string, context?: FlagContext): boolean {
    const def = this._snapshot[flag];
    return evaluateFlag(flag, def, context);
  }

  /**
   * Loads initial state ONCE and arms the poll interval ONCE.
   */
  async start(): Promise<void> {
    // Initial synchronous load from the injected store
    this._snapshot = await this._store.loadFlags();
    this._lastError = undefined;

    // Arm the repeating interval exactly once (never inside _poll).
    // If the store rejects repeatedly, status() reports degraded but
    // isEnabled continues serving the last good snapshot.
    this._timer = {
      handle: this._runtime.setInterval(() => this._poll(), this._refreshIntervalMs),
    };
  }

  /**
   * Stops the poll timer. Guards against stop()-before-arm (no-op if start
   * was never called or the timer is already cleared).
   */
  stop(): Promise<void> {
    if (this._timer) {
      this._runtime.clearInterval(this._timer.handle);
      this._timer = undefined;
    }
    return Promise.resolve();
  }

  /**
   * Returns status: healthy when the last poll succeeded; degraded when it failed.
   */
  status(): FlagProviderStatus {
    if (this._lastError !== undefined) {
      return { healthy: false, detail: this._lastError };
    }
    return { healthy: true };
  }

  /**
   * Poll callback — called by the single interval armed in start().
   *
   * Loads flags into the snapshot; on failure records the error via
   * `this._lastError`, logs via `this._logger?.warn`, and keeps the last
   * good snapshot. A subsequent successful poll clears the recorded error.
   * Does NOT re-arm the interval.
   */
  private _poll = async (): Promise<void> => {
    try {
      this._snapshot = await this._store.loadFlags();
      this._lastError = undefined;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._logger?.warn(`[feature-flags] DatabaseProvider poll failed: ${this._lastError}`);
    }
  };
}
