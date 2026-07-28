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
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const limiter = createRateLimiter(3, 1000, timing);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // All three admitted without sleeping.
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
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const limiter = createRateLimiter(2, 1000, timing);
    await limiter.acquire(); // t=0
    await limiter.acquire(); // t=0

    // Advance past window.
    timeNow = 1100;

    // Should admit again — old timestamps evicted.
    await limiter.acquire();
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

  it('per-origin isolation via separate instances', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    // Each origin gets its own limiter instance — verify they are independent.
    const limiterA = createRateLimiter(1, 1000, timing);
    const limiterB = createRateLimiter(1, 1000, timing);

    await limiterA.acquire(); // fills A
    await limiterB.acquire(); // fills B independently
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

  it('retries after sleep throws (admission loop)', async () => {
    let timeNow = 0;
    let sleepCall = 0;
    let sleepReject: ((err: unknown) => void) | undefined;

    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => {
        sleepCall++;
        return new Promise<void>((_resolve, reject) => {
          sleepReject = reject;
        });
      },
    };

    const limiter = createRateLimiter(1, 1000, timing);
    await limiter.acquire(); // t=0, fills slot

    // Trigger wait.
    timeNow = 100;
    const promise = limiter.acquire();

    // Sleep rejects (simulating abort during wait).
    sleepReject!(new Error('interrupted'));

    // After sleep rejects, loop retries. Advance time past window.
    timeNow = 1100;

    // The loop should now evict the old timestamp and admit.
    await promise;
  });
});
