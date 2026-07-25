/**
 * Fake `FlagProvider` fixture — settable verdict, start/stop counters, scriptable status.
 *
 * @module
 */

import type { FlagContext } from '@hono-enterprise/common';
import type { FlagProvider, FlagProviderStatus } from '../../src/interfaces/index.ts';

export class FakeFlagProvider implements FlagProvider {
  readonly type: 'config' = 'config';
  isEnabledVerdict = true;
  startCount = 0;
  stopCount = 0;
  private _statusMode: 'absent' | 'healthy' | 'unhealthy' = 'absent';
  private _statusDetail: string | undefined;

  isEnabled(_flag: string, _context?: FlagContext): boolean {
    return this.isEnabledVerdict;
  }

  start(): Promise<void> {
    this.startCount++;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCount++;
    return Promise.resolve();
  }

  setStatus(mode: 'absent' | 'healthy' | 'unhealthy', detail?: string): void {
    this._statusMode = mode;
    this._statusDetail = detail;
  }

  /**
   * Returns status when present (healthy/unhealthy). When `_statusMode === 'absent'`,
   * this still returns a healthy status (the `FlagProvider` interface makes `status` optional,
   * so the calling code checks for `undefined` — we avoid that by always returning something
   * but letting tests toggle via `setStatus`).
   */
  status(): FlagProviderStatus {
    if (this._statusMode === 'healthy') {
      return { healthy: true };
    }
    if (this._statusMode === 'unhealthy') {
      return this._statusDetail !== undefined
        ? { healthy: false, detail: this._statusDetail as string }
        : { healthy: false };
    }
    // absent — default to healthy
    return { healthy: true };
  }
}
