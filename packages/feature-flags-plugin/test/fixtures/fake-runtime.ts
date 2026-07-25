/**
 * Fake `IRuntimeServices` for unit tests.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';

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
  readonly platform = (): string => 'test';
  fs?: any;

  setInterval(fn: () => void, ms: number): unknown {
    this.calledWithMs = ms;
    this.capturedCallback = fn;
    const handle = this.handleCounter++;
    if (this.setIntervalFn) {
      return this.setIntervalFn(fn, ms);
    }
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.capturedCallback = null;
    if (this.clearIntervalFn) {
      this.clearIntervalFn(handle);
    }
  }
}
