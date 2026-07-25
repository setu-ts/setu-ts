/**
 * Fake `FlagProvider` fixture — settable verdict, start/stop counters, scriptable status.
 *
 * @module
 */

import type { FlagContext, FlagProvider, FlagProviderStatus } from '../../src/interfaces/index.ts';

export class FakeFlagProvider implements FlagProvider {
  type: 'config' = 'config';
  isEnabledVerdict = true;
  startCount = 0;
  stopCount = 0;
  private _statusMode: 'absent' | 'healthy' | 'unhealthy' = 'absent';
  private _statusDetail?: string;

  isEnabled(_flag: string, _context?: FlagContext): boolean {
    return this.isEnabledVerdict;
  }

  async start(): Promise<void> {
    this.startCount++;
  }

  async stop(): Promise<void> {
    this.stopCount++;
  }

  setStatus(mode: 'absent' | 'healthy' | 'unhealthy', detail?: string): void {
    this._statusMode = mode;
    this._statusDetail = detail;
  }

  status?(): FlagProviderStatus {
    if (this._statusMode === 'absent') {
      return undefined;
    }
    if (this._statusMode === 'healthy') {
      return { healthy: true };
    }
    return { healthy: false, detail: this._statusDetail };
  }
}
