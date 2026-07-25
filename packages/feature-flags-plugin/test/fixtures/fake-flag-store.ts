/**
 * Fake `IFlagStore` — records `loadFlags` calls, supports resolve/reject queuing.
 *
 * @module
 */

import type { FlagDefinition, IFlagStore } from '../../src/interfaces/index.ts';

export class FakeFlagStore implements IFlagStore {
  private _pendingResolve: ((val: Readonly<Record<string, FlagDefinition>>) => void) | null = null;
  private _pendingReject: ((err: Error) => void) | null = null;
  private _nextShouldFail = false;
  private _defaultResult: Readonly<Record<string, FlagDefinition>> = {};
  public loadCallCount = 0;

  /** Set the default result returned when no queued resolver exists. */
  setDefault(result: Readonly<Record<string, FlagDefinition>>): void {
    this._defaultResult = result;
  }

  /** Queue a successful resolve for the next `loadFlags` call. */
  queueResolve(result: Readonly<Record<string, FlagDefinition>>): void {
    if (this._pendingResolve) {
      this._pendingResolve(result);
      this._pendingResolve = null;
    } else {
      // Store so that the next synchronous call will use it
      this._defaultResult = result;
    }
  }

  /** Queue a rejection for the next `loadFlags` call. */
  queueReject(err: Error = new Error('store error')): void {
    this._nextShouldFail = true;
    this._pendingReject?.(err);
    this._pendingReject = null;
  }

  async loadFlags(): Promise<Readonly<Record<string, FlagDefinition>>> {
    this.loadCallCount++;
    if (this._nextShouldFail) {
      this._nextShouldFail = false;
      throw new Error('store error');
    }
    if (this._pendingResolve) {
      const fn = this._pendingResolve;
      this._pendingResolve = null;
      // Wait a tick then resolve
      await Promise.resolve();
      fn(this._defaultResult);
      return this._defaultResult;
    }
    return this._defaultResult;
  }
}
