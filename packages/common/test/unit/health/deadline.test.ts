import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deadlineRangeError, withDeadline } from '../../../src/health/deadline.ts';
import type { DeadlineOptions } from '../../../src/health/deadline.ts';
import type { TimerHandle } from '../../../src/runtime.ts';

/** A controllable timer surface: nothing fires until `fire()` is called. */
class FakeTimers {
  readonly armed: Array<{ fn: () => void; ms: number; handle: number }> = [];
  readonly cleared: number[] = [];
  #next = 0;

  readonly setTimer = (fn: () => void, ms: number): TimerHandle => {
    this.#next += 1;
    this.armed.push({ fn, ms, handle: this.#next });
    return this.#next;
  };

  readonly clearTimer = (handle: TimerHandle): void => {
    this.cleared.push(handle as number);
  };

  fire(): void {
    const timer = this.armed.at(-1);
    if (timer === undefined) throw new Error('no timer armed');
    timer.fn();
  }
}

class Timeout extends Error {}

function options(timers: FakeTimers, timeoutMs = 100): DeadlineOptions {
  return { timeoutMs, onTimeout: () => new Timeout('deadline'), timing: timers };
}

describe('withDeadline', () => {
  it('resolves the call value when it settles before the bound, clearing the timer', async () => {
    const timers = new FakeTimers();

    await expect(withDeadline(() => Promise.resolve(42), options(timers))).resolves.toBe(42);
    expect(timers.armed).toHaveLength(1);
    expect(timers.armed[0]?.ms).toBe(100);
    expect(timers.cleared).toEqual([1]);
  });

  it('rejects with the caller error and aborts the signal when the bound fires', async () => {
    const timers = new FakeTimers();
    let seen: AbortSignal | undefined;

    const pending = withDeadline((signal) => {
      seen = signal;
      return new Promise<number>(() => {});
    }, options(timers));
    await Promise.resolve();
    await Promise.resolve();
    timers.fire();

    await expect(pending).rejects.toBeInstanceOf(Timeout);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(Timeout);
    expect(timers.cleared).toEqual([1]);
  });

  it('rejects at the bound even when the call ignores its signal', async () => {
    const timers = new FakeTimers();

    // The call never looks at the signal and never settles — the race, not the
    // signal, is what ends the wait.
    const pending = withDeadline(() => new Promise<string>(() => {}), options(timers));
    timers.fire();

    await expect(pending).rejects.toThrow('deadline');
  });

  it('propagates the call rejection unchanged and clears the timer', async () => {
    const timers = new FakeTimers();
    const own = new Error('connection refused');

    await expect(withDeadline(() => Promise.reject(own), options(timers))).rejects.toBe(own);
    expect(timers.cleared).toEqual([1]);
  });

  it('turns a synchronous throw from the call into a rejection', async () => {
    const timers = new FakeTimers();
    const own = new Error('sync');

    const pending = withDeadline(() => {
      throw own;
    }, options(timers));

    await expect(pending).rejects.toBe(own);
  });

  it('arms no timer when timeoutMs is 0 and returns the call outcome', async () => {
    const timers = new FakeTimers();

    await expect(withDeadline(() => Promise.resolve('x'), options(timers, 0))).resolves.toBe('x');
    expect(timers.armed).toHaveLength(0);
  });

  it('builds the expiry error only on expiry', async () => {
    const timers = new FakeTimers();
    let built = 0;

    await withDeadline(() => Promise.resolve(1), {
      timeoutMs: 50,
      onTimeout: () => {
        built += 1;
        return new Error('x');
      },
      timing: timers,
    });

    expect(built).toBe(0);
  });

  it('falls back to the ambient timers when no timing is supplied', async () => {
    await expect(
      withDeadline(() => Promise.resolve('ambient'), {
        timeoutMs: 1000,
        onTimeout: () => new Error('x'),
      }),
    ).resolves.toBe('ambient');

    // The ambient timer genuinely fires: a never-settling call is rejected.
    await expect(
      withDeadline(() => new Promise<never>(() => {}), {
        timeoutMs: 1,
        onTimeout: () => new Timeout('ambient deadline'),
      }),
    ).rejects.toBeInstanceOf(Timeout);
  });

  const refused: ReadonlyArray<readonly [string, number]> = [
    ['NaN', Number.NaN],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['over the timer range', 2_147_483_648],
  ];
  for (const [label, value] of refused) {
    it(`rejects (never throws) a ${label} timeoutMs with RangeError, arming nothing`, async () => {
      const timers = new FakeTimers();
      let ran = false;

      const pending = withDeadline(() => {
        ran = true;
        return Promise.resolve(1);
      }, options(timers, value));

      await expect(pending).rejects.toBeInstanceOf(RangeError);
      expect(ran).toBe(false);
      expect(timers.armed).toHaveLength(0);
    });
  }
});

describe('deadlineRangeError', () => {
  const accepted: readonly number[] = [0, 1, 5000, 2_147_483_647];
  for (const value of accepted) {
    it(`accepts ${value}`, () => {
      expect(deadlineRangeError('opt', value)).toBeNull();
    });
  }

  it('names the option in the refusal', () => {
    const refusal = deadlineRangeError('requestTimeoutMs', -5);

    expect(refusal).toBeInstanceOf(RangeError);
    expect(refusal?.message).toContain('requestTimeoutMs');
  });
});
