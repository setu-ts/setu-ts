/**
 * Fake `IRuntimeServices` for unit tests.
 *
 * @module
 */

import type { IRuntimeServices, RuntimePlatform } from '@setu-ts/common';

export class FakeRuntimeServices implements IRuntimeServices {
  setIntervalFn: ((fn: () => void, ms: number) => unknown) | null = null;
  clearIntervalFn: ((handle: unknown) => void) | null = null;
  calledWithMs: number | null = null;
  capturedCallback: (() => void) | null = null;
  handleCounter = 0;
  readonly env: Record<string, string | undefined> = {};
  readonly hrtime = (): number => performance.now();
  readonly now = (): number => Date.now();
  readonly uuid = (): string => 'fake-uuid';
  readonly randomBytes = (n: number): Uint8Array => new Uint8Array(n);
  readonly subtle: SubtleCrypto = globalThis.crypto.subtle;

  setInterval(fn: () => void, ms: number): unknown {
    this.capturedCallback = fn;
    this.calledWithMs = ms;
    this.handleCounter += 1;
    return `handle-${this.handleCounter}`;
  }

  clearInterval(handle: unknown): void {
    if (this.clearIntervalFn) {
      this.clearIntervalFn(handle);
    }
  }

  setTimeout(): unknown {
    this.handleCounter += 1;
    return `timeout-handle-${this.handleCounter}`;
  }

  clearTimeout(): void {}

  platform(): RuntimePlatform {
    return 'deno';
  }

  version(): string {
    return 'test';
  }

  hostname(): string {
    return 'localhost';
  }

  exit(): never {
    throw new Error('exit not implemented');
  }
}
