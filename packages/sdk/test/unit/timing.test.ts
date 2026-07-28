/**
 * Tests for `createDefaultClientTiming()`.
 *
 * Covers monotonic `now()`, `sleep` resolution, and abort behavior.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDefaultClientTiming } from '../../src/http/timing.ts';

describe('createDefaultClientTiming', () => {
  it('now() returns a positive number', () => {
    const timing = createDefaultClientTiming();
    const now = timing.now();
    expect(now).toBeGreaterThanOrEqual(0);
  });

  it('now() is monotonic non-decreasing', () => {
    const timing = createDefaultClientTiming();
    const a = timing.now();
    const b = timing.now();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('sleep(0) resolves', async () => {
    const timing = createDefaultClientTiming();
    await timing.sleep(0);
    // resolved without throwing
  });

  it('sleep resolves after delay', async () => {
    const timing = createDefaultClientTiming();
    const start = timing.now();
    await timing.sleep(10);
    const elapsed = timing.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8); // allow small jitter
  });

  it('sleep rejects when signal aborts mid-wait', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();

    const sleepPromise = timing.sleep(1000, controller.signal);

    // Abort after a short delay.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error('custom abort'));

    await expect(sleepPromise).rejects.toThrow('custom abort');
  });

  it('sleep rejects immediately when given already-aborted signal', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();
    const err = new Error('already aborted');
    controller.abort(err);

    await expect(timing.sleep(100, controller.signal)).rejects.toThrow('already aborted');
  });

  it('sleep rejects with default AbortError when already-aborted has no reason', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();
    controller.abort(); // no custom reason — triggers signal.reason ?? new DOMException(...)

    await expect(timing.sleep(100, controller.signal)).rejects.toThrow();
  });

  it('sleep rejects with AbortError when no custom reason', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();
    controller.abort();

    await expect(timing.sleep(100, controller.signal)).rejects.toThrow();
  });

  it('sleep rejects with AbortError when signal aborts mid-wait (no reason)', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();

    const sleepPromise = timing.sleep(1000, controller.signal);

    await new Promise((r) => setTimeout(r, 5));
    controller.abort(); // no custom reason

    await expect(sleepPromise).rejects.toThrow();
  });

  it('sleep with signal present resolves when timer fires first', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();

    // Signal exists but is never aborted — timer fires and cleanup runs.
    await timing.sleep(0, controller.signal);
    // resolved without throwing — covers addEventListener + cleanup path
  });

  it('sleep already-aborted propagates custom reason via signal.reason', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();
    const customReason = new Error('my reason');
    controller.abort(customReason);

    try {
      await timing.sleep(100, controller.signal);
      throw new Error('should not reach');
    } catch (err: unknown) {
      expect(err).toBe(customReason);
    }
  });

  it('sleep mid-wait abort propagates custom reason via signal!.reason', async () => {
    const timing = createDefaultClientTiming();
    const controller = new AbortController();
    const customReason = new Error('mid-wait reason');

    const sleepPromise = timing.sleep(1000, controller.signal);

    await new Promise((r) => setTimeout(r, 5));
    controller.abort(customReason);

    try {
      await sleepPromise;
      throw new Error('should not reach');
    } catch (err: unknown) {
      expect(err).toBe(customReason);
    }
  });

  // ============================================================================
  // Fallback branch tests: cover the ?? new DOMException('Aborted', 'AbortError')
  // paths that only trigger when signal.reason is truly nullish on an aborted signal.
  // A spec-compliant runtime never produces this, so we use a fake signal.
  // ============================================================================

  it('sleep rejects with AbortError when early-aborted signal has nullish reason (fallback)', async () => {
    const timing = createDefaultClientTiming();

    // Create a fake AbortSignal with aborted: true and reason: undefined.
    // This simulates a scenario where the fallback ?? new DOMException(...) would fire.
    const fakeSignal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    await expect(timing.sleep(100, fakeSignal)).rejects.toThrow();
  });

  it('sleep rejects with AbortError when mid-wait abort triggers fallback (nullish reason)', async () => {
    const timing = createDefaultClientTiming();

    // Create a fake AbortSignal that is NOT initially aborted.
    // The addEventListener immediately invokes the handler to simulate abort.
    // This triggers the onAbort callback in sleep, which reads signal!.reason
    // (which is undefined) and uses the fallback.
    const fakeSignal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, handler: () => void) => {
        // Simulate abort by immediately invoking the handler.
        handler();
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    const sleepPromise = timing.sleep(100, fakeSignal);

    await expect(sleepPromise).rejects.toThrow();
  });
});
