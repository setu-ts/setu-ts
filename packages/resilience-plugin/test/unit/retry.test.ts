import { describe, expect, it } from 'vitest';
import type { RetryPolicy } from '@setu-ts/common';
import { computeBackoffMs, runWithRetry } from '../../src/patterns/retry.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const FIXED: RetryPolicy = { limit: 3, delay: 100, backoff: 'fixed' };
const EXP: RetryPolicy = { limit: 3, delay: 100, backoff: 'exponential' };

describe('computeBackoffMs', () => {
  it('fixed backoff is constant at every attempt', () => {
    expect(computeBackoffMs(1, FIXED)).toBe(100);
    expect(computeBackoffMs(2, FIXED)).toBe(100);
    expect(computeBackoffMs(3, FIXED)).toBe(100);
  });

  it('exponential backoff doubles per attempt', () => {
    expect(computeBackoffMs(1, EXP)).toBe(100);
    expect(computeBackoffMs(2, EXP)).toBe(200);
    expect(computeBackoffMs(3, EXP)).toBe(400);
  });
});

describe('runWithRetry', () => {
  it('returns on the first attempt without arming a timer', async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const result = await runWithRetry(
      () => {
        calls++;
        return Promise.resolve('ok');
      },
      FIXED,
      runtime,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(runtime.armedDelays).toEqual([]);
  });

  it('retries after the computed backoff and succeeds', async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const result = await runWithRetry(
      () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve('recovered');
      },
      EXP,
      runtime,
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
    // One backoff armed before the 2nd attempt: computeBackoffMs(1) = 100.
    expect(runtime.armedDelays).toEqual([100]);
  });

  it('throws the last error after exactly `limit` attempts', async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    let caught: unknown;
    try {
      await runWithRetry(
        () => {
          calls++;
          return Promise.reject(new Error(`fail-${calls}`));
        },
        EXP,
        runtime,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('fail-3');
    expect(calls).toBe(3);
    // Backoffs armed before attempts 2 and 3: 100, 200. None after the last.
    expect(runtime.armedDelays).toEqual([100, 200]);
  });

  it('makes a single attempt with no retry when limit is 1', async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    let caught: unknown;
    try {
      await runWithRetry(
        () => {
          calls++;
          return Promise.reject(new Error('once'));
        },
        { limit: 1, delay: 50, backoff: 'fixed' },
        runtime,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('once');
    expect(calls).toBe(1);
    expect(runtime.armedDelays).toEqual([]);
  });
});

describe('runWithRetry cancellation', () => {
  it('rejects without invoking fn when the signal is already aborted', async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    let calls = 0;

    let caught: unknown;
    try {
      await runWithRetry(
        () => {
          calls++;
          return Promise.reject(new Error('boom'));
        },
        FIXED,
        runtime,
        controller.signal,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reason);
    expect(calls).toBe(0);
  });

  it('stops retrying once the signal aborts mid-sequence', async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    let calls = 0;

    let caught: unknown;
    try {
      await runWithRetry(
        () => {
          calls++;
          // Cancel during the first attempt: the loop must not make a second.
          controller.abort(new Error('cancelled mid-flight'));
          return Promise.reject(new Error('boom'));
        },
        FIXED,
        runtime,
        controller.signal,
      );
    } catch (error) {
      caught = error;
    }

    expect(calls).toBe(1);
    expect((caught as Error).message).toBe('cancelled mid-flight');
    // No backoff was armed, because the sequence ended instead of sleeping.
    expect(runtime.armedDelays).toEqual([]);
  });

  it('wakes the backoff early when the signal aborts while sleeping', async () => {
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    let calls = 0;

    const pending = runWithRetry(
      () => {
        calls++;
        return Promise.reject(new Error('boom'));
      },
      { limit: 5, delay: 60_000, backoff: 'fixed' },
      runtime,
      controller.signal,
    );

    // Let the first attempt fail and park in the (very long) backoff.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled while sleeping'));

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }

    // Without the interruptible sleep this would still be waiting a full minute.
    expect((caught as Error).message).toBe('cancelled while sleeping');
    expect(calls).toBe(1);
  });

  it('hands every attempt a live signal when no caller signal is supplied', async () => {
    const runtime = new FakeRuntime();
    const seen: boolean[] = [];

    let caught: unknown;
    try {
      await runWithRetry(
        (signal) => {
          seen.push(signal.aborted);
          return Promise.reject(new Error('boom'));
        },
        FIXED,
        runtime,
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe('boom');
    expect(seen).toEqual([false, false, false]);
  });
});

describe('M131b 3.12 retry validation', () => {
  for (const policy of [
    { limit: 0, delay: 0 },
    { limit: NaN, delay: 0 },
    { limit: 1.5, delay: 0 },
    { limit: -1, delay: 0 },
    { limit: Infinity, delay: 0 },
    { limit: Number.MAX_SAFE_INTEGER + 1, delay: 0 },
    { limit: 1, delay: -1 },
    { limit: 1, delay: NaN },
    { limit: 1, delay: Infinity },
    // M131b audit F4: a runtime timer clamps anything above 2^31 - 1 ms to 1 ms.
    { limit: 1, delay: 2_147_483_648 },
    { limit: 1, delay: 1e308 },
  ]) {
    it(`refuses invalid policies at wrap: ${JSON.stringify(policy)}`, async () => {
      const { ResilienceService } = await import('../../src/services/resilience-service.ts');
      const runtime = new FakeRuntime();
      const service = new ResilienceService(runtime);
      const retry = { ...policy, backoff: 'fixed' as const };
      expect(() => service.wrap(() => Promise.resolve(1), { retry })).toThrow(RangeError);
      const defaults = new ResilienceService(runtime, { defaultRetry: retry });
      expect(() => defaults.wrap(() => Promise.resolve(1), { retry: true })).toThrow(RangeError);
    });
  }
});

it('M131b review: an edit to the policy after wrap does not reach the call', async () => {
  const { ResilienceService } = await import('../../src/services/resilience-service.ts');
  const runtime = new FakeRuntime();
  for (const fromDefault of [false, true]) {
    const policy = { limit: 2, delay: 0, backoff: 'fixed' as const };
    const service = new ResilienceService(
      runtime,
      fromDefault ? { defaultRetry: policy } : undefined,
    );
    let calls = 0;
    const call = service.wrap(
      () => {
        calls += 1;
        return calls < 2 ? Promise.reject(new Error('transient')) : Promise.resolve('ok');
      },
      { retry: fromDefault ? true : policy },
    );
    // Neither edit passes validation; the wrapped call keeps the validated copy.
    (policy as { limit: number }).limit = 0;
    await expect(call()).resolves.toBe('ok');
    expect(calls).toBe(2);
  }
});

describe('M131b audit F4: timer-bounded delays', () => {
  it('accepts the longest delay a timer honours', async () => {
    const { validateRetryPolicy } = await import('../../src/patterns/retry.ts');
    expect(() =>
      validateRetryPolicy({ limit: 2, delay: 2_147_483_647, backoff: 'fixed' }, 'test'),
    ).not.toThrow();
  });

  it('caps a long exponential schedule at the timer maximum', () => {
    const policy: RetryPolicy = { limit: 40, delay: 1_000_000_000, backoff: 'exponential' };
    expect(computeBackoffMs(1, policy)).toBe(1_000_000_000);
    expect(computeBackoffMs(2, policy)).toBe(2_000_000_000);
    expect(computeBackoffMs(3, policy)).toBe(2_147_483_647);
    expect(computeBackoffMs(30, policy)).toBe(2_147_483_647);
  });

  it('keeps a zero exponential delay at zero past 2^1024 (re-audit O-2)', () => {
    expect(computeBackoffMs(1025, { limit: 2000, delay: 0, backoff: 'exponential' })).toBe(0);
  });
});
