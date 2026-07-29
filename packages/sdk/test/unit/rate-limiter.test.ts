/**
 * Tests for the internal rate limiter.
 *
 * Uses fake timing for admission, window expiry, per-origin isolation,
 * queued waits, and abort behavior.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createRateLimiter } from '../../src/http/rate-limiter.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

describe('createRateLimiter', () => {
  it('admits immediately within window', async () => {
    const timeNow = 0;
    let sleepCalls = 0;
    const counting: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        sleepCalls++;
        return Promise.resolve();
      },
    };
    const limiter = createRateLimiter(3, 1000, counting);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // Admitted without waiting: the window had capacity for all three.
    expect(sleepCalls).toEqual(0);
  });

  it('waits when window is full', async () => {
    let timeNow = 0;
    let sleepResolve: (() => void) | undefined;
    let sleepMs: number | undefined;

    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: (ms: number) => {
        sleepMs = ms;
        return new Promise<void>((resolve) => {
          sleepResolve = resolve;
        });
      },
    };

    const limiter = createRateLimiter(2, 1000, timing);
    await limiter.acquire(); // t=0
    await limiter.acquire(); // t=0

    // Advance time slightly.
    timeNow = 100;

    // Third call should wait.
    const promise = limiter.acquire();

    // Should have called sleep with the right delay.
    expect(sleepMs).toEqual(900);

    // Advance past window and resolve sleep.
    timeNow = 1100;
    sleepResolve!();

    await promise;
  });

  it('evicts expired timestamps', async () => {
    let timeNow = 0;
    let sleepCalls = 0;
    const counting: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        sleepCalls++;
        return Promise.resolve();
      },
    };
    const limiter = createRateLimiter(2, 1000, counting);
    await limiter.acquire(); // t=0
    await limiter.acquire(); // t=0
    expect(sleepCalls).toEqual(0);

    // Advance past window.
    timeNow = 1100;

    // Admits immediately — the two t=0 timestamps aged out, so no wait.
    await limiter.acquire();
    expect(sleepCalls).toEqual(0);
  });

  it('aborts queued wait without consuming a slot', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () =>
        new Promise<never>(() => {
          // Never resolves — we'll abort first.
        }),
    };
    const limiter = createRateLimiter(1, 1000, timing);
    await limiter.acquire(); // t=0

    const controller = new AbortController();
    controller.abort(new Error('aborted'));

    await expect(limiter.acquire(controller.signal)).rejects.toThrow('aborted');
  });

  it('handles already-aborted signal', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const limiter = createRateLimiter(1, 1000, timing);
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));

    await expect(limiter.acquire(controller.signal)).rejects.toThrow('already aborted');
  });

  it('separate limiter instances keep independent state', async () => {
    let timeNow = 0;
    // Each origin gets its own limiter instance. Without independent state,
    // filling A would force B to wait, so count the waits to prove it does not.
    let sleepCalls = 0;
    const counting: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        sleepCalls++;
        return Promise.resolve();
      },
    };
    const limiterA = createRateLimiter(1, 1000, counting);
    const limiterB = createRateLimiter(1, 1000, counting);

    await limiterA.acquire(); // fills A's single slot
    await limiterB.acquire(); // B still has its own free slot
    expect(sleepCalls).toEqual(0);

    // A is now full: the next A acquisition DOES wait, proving the counter works.
    const pending = limiterA.acquire();
    timeNow = 1100;
    await pending;
    expect(sleepCalls).toEqual(1);
  });

  it('propagates custom abort reason from signal.reason', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const limiter = createRateLimiter(1, 1000, timing);
    const controller = new AbortController();
    const customReason = new Error('custom limiter abort');
    controller.abort(customReason);

    try {
      await limiter.acquire(controller.signal);
      throw new Error('should not reach');
    } catch (err: unknown) {
      expect(err).toBe(customReason);
    }
  });

  it('propagates a non-abort sleep rejection instead of looping', async () => {
    // A non-abort `sleep` rejection means the injected timing seam is faulty.
    // Swallowing it re-entered the admission loop with the window still full and
    // no attempt bound, so a persistently rejecting `sleep` span forever and the
    // cause was lost.
    let timeNow = 0;
    let sleepCalls = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        sleepCalls++;
        return Promise.reject(new Error('timing seam broken'));
      },
    };

    const limiter = createRateLimiter(1, 1000, timing);
    await limiter.acquire(); // t=0, fills the only slot

    timeNow = 100; // still inside the window, so the next acquire must wait
    await expect(limiter.acquire()).rejects.toThrow('timing seam broken');
    // Exactly one wait attempt — it did not spin.
    expect(sleepCalls).toEqual(1);
  });

  it('retries the admission loop when the wait is interrupted by an abort', async () => {
    // An abort IS expected mid-wait: the loop falls through to its guard, which
    // throws the abort reason.
    let timeNow = 0;
    const controller = new AbortController();
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        controller.abort(new Error('caller gave up'));
        return Promise.reject(controller.signal.reason);
      },
    };

    const limiter = createRateLimiter(1, 1000, timing);
    await limiter.acquire();

    timeNow = 100;
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('caller gave up');
  });
});
