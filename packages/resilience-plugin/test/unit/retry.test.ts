import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RetryPolicy } from '@hono-enterprise/common';
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
