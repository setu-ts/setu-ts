/**
 * Tests for the internal circuit breaker.
 *
 * Covers rolling-window trip, open→reject, half-open recovery,
 * injected classifier outcomes, the shared window, and concurrent probe rejection.
 */

import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../src/circuit-breaker/circuit-breaker.ts';
import { ClientCircuitOpenError } from '../../src/errors.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

describe('createCircuitBreaker', () => {
  it('allows calls in closed state', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 3, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toEqual('ok');
  });

  it('trips open after threshold failures within window', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 3, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    }

    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(ClientCircuitOpenError);
  });

  it('half-open after resetTimeout allows one probe', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 2000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );

    // Trip the breaker.
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past reset timeout but before window expiry → half-open.
    timeNow = 600;

    // Probe succeeds → recovery.
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toEqual('recovered');

    // Back to closed.
    const result2 = await cb.execute(() => Promise.resolve('closed'));
    expect(result2).toEqual('closed');
  });

  it('a failed half-open probe reopens the circuit and RESTARTS the cooldown', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 5000, resetTimeout: 2000 },
      timing,
      () => 'failure',
    );
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('still down'));
    };

    // Trip the breaker at t=0.
    await expect(cb.execute(failing)).rejects.toThrow('still down');
    await expect(cb.execute(failing)).rejects.toThrow('still down');
    expect(calls).toBe(2);

    // Advance past resetTimeout → one probe is admitted, and it fails.
    timeNow = 2001;
    await expect(cb.execute(failing)).rejects.toThrow('still down');
    expect(calls).toBe(3);

    // The failed probe restarted the cooldown from t=2001, so the very next call
    // must fail FAST rather than probe the dead dependency again. Before this was
    // fixed the cooldown was measured from the oldest failure (t=0), which had
    // already elapsed, so every subsequent call re-probed.
    timeNow = 2002;
    await expect(cb.execute(failing)).rejects.toThrow(ClientCircuitOpenError);
    expect(calls).toBe(3);

    // Once the restarted cooldown elapses, a probe is admitted again.
    timeNow = 4002;
    await expect(cb.execute(failing)).rejects.toThrow('still down');
    expect(calls).toBe(4);
  });

  it('stays open for resetTimeout even when the failure window is shorter', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    // `timeout` (rolling window) is deliberately SHORTER than `resetTimeout`.
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 10_000 },
      timing,
      () => 'failure',
    );
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('down'));
    };

    await expect(cb.execute(failing)).rejects.toThrow('down');
    await expect(cb.execute(failing)).rejects.toThrow('down');
    expect(calls).toBe(2);

    // Past the 1000ms failure window but far short of the 10s cooldown. When the
    // cooldown was measured from the oldest failure, the window expiring here
    // silently CLOSED the circuit and the half-open state was unreachable.
    timeNow = 1500;
    await expect(cb.execute(failing)).rejects.toThrow(ClientCircuitOpenError);
    expect(calls).toBe(2);

    // Still open just before the cooldown elapses.
    timeNow = 9999;
    await expect(cb.execute(failing)).rejects.toThrow(ClientCircuitOpenError);
    expect(calls).toBe(2);

    // Cooldown elapsed → exactly one probe admitted.
    timeNow = 10_000;
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toEqual('recovered');
  });

  it('a probe rejecting with a non-counting error leaves the circuit probeable', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 5000, resetTimeout: 500 },
      timing,
      (err: unknown) =>
        err instanceof Error && err.message === 'user-error' ? 'ignore' : 'failure',
    );

    // Trip on two counting failures.
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');

    // Cooldown elapses; the probe throws a NON-counting error.
    timeNow = 600;
    await expect(cb.execute(() => Promise.reject(new Error('user-error')))).rejects.toThrow(
      'user-error',
    );

    // The cooldown was not restarted (nothing was counted), and the in-flight
    // flag was released, so the next call is admitted as a fresh probe.
    let probed = false;
    const result = await cb.execute(() => {
      probed = true;
      return Promise.resolve('ok');
    });
    expect(probed).toBe(true);
    expect(result).toEqual('ok');
  });

  it('ages failures out of the rolling window so a slow drip never trips', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 3, timeout: 1000, resetTimeout: 5000 },
      timing,
      () => 'failure',
    );

    // One failure every 900ms: never three inside any 1000ms window.
    for (const t of [0, 900, 1800, 2700, 3600]) {
      timeNow = t;
      await expect(cb.execute(() => Promise.reject(new Error('blip')))).rejects.toThrow('blip');
    }

    // Still closed — the call reaches `fn`.
    timeNow = 4500;
    let reached = false;
    await cb.execute(() => {
      reached = true;
      return Promise.resolve('ok');
    });
    expect(reached).toBe(true);
  });

  it('rejects concurrent calls during half-open', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 2000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );

    // Trip.
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past reset timeout.
    timeNow = 600;

    // Start a probe (simulated by a long-running promise).
    const probePromise = cb.execute(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 50)),
    );

    // Concurrent call should be rejected.
    await expect(cb.execute(() => Promise.resolve('concurrent'))).rejects.toThrow(
      ClientCircuitOpenError,
    );

    // Let probe complete.
    const result = await probePromise;
    expect(result).toEqual('ok');
  });

  it('a rejection the classifier ignores does not count as failure', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 500 },
      timing,
      (err: unknown) =>
        err instanceof Error && err.message === 'not-counted' ? 'ignore' : 'failure',
    );

    await expect(cb.execute(() => Promise.reject(new Error('not-counted')))).rejects.toThrow(
      'not-counted',
    );
    await expect(cb.execute(() => Promise.reject(new Error('not-counted')))).rejects.toThrow(
      'not-counted',
    );

    // Should still be closed — errors not counted.
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toEqual('ok');
  });

  it('a rejection the classifier marks a failure counts', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );

    await expect(cb.execute(() => Promise.reject(new Error('counted')))).rejects.toThrow('counted');
    await expect(cb.execute(() => Promise.reject(new Error('counted')))).rejects.toThrow('counted');

    // Should be open.
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(ClientCircuitOpenError);
  });

  it('old failures expire outside window', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );

    // Two failures at t=0.
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past failure window.
    timeNow = 2000;

    // Should be closed again — failures expired.
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toEqual('ok');
  });

  it('a success between failures does not clear them: the count arm trips within timeout', async () => {
    let timeNow = 0;
    const timing: IClientTiming = { now: () => timeNow, sleep: () => Promise.resolve() };
    const cb = createCircuitBreaker(
      { threshold: 3, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );
    for (const at of [0, 100]) {
      timeNow = at;
      await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
      timeNow = at + 50;
      await expect(cb.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    }
    timeNow = 200;
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    // The third failure (at 200) tripped the circuit despite the successes.
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(ClientCircuitOpenError);
  });

  it('a call admitted while closed that succeeds after the trip leaves the circuit open', async () => {
    const timing: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };
    const cb = createCircuitBreaker(
      { threshold: 1, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );
    let release: (value: string) => void = () => {};
    const slow = cb.execute(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    release('late');
    await expect(slow).resolves.toBe('late');
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(ClientCircuitOpenError);
  });

  it('the rate arm trips on the failure rate and then fails fast', async () => {
    const timing: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };
    const cb = createCircuitBreaker(
      { failureRateThreshold: 50, minimumCalls: 4, timeout: 1000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );
    await cb.execute(() => Promise.resolve('ok'));
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    await cb.execute(() => Promise.resolve('ok'));
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    let called = false;
    await expect(
      cb.execute(() => {
        called = true;
        return Promise.resolve('ok');
      }),
    ).rejects.toThrow(
      new ClientCircuitOpenError('Circuit breaker open for origin; 2 failures in window'),
    );
    expect(called).toBe(false);
  });

  it('rejections classified as success sit in the rate denominator; ignored ones do not', async () => {
    const timing: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };
    const outcome = (error: unknown) =>
      error instanceof Error && error.message === 'not-found'
        ? 'success'
        : error instanceof Error && error.message === 'aborted'
          ? 'ignore'
          : 'failure';
    const policy = { failureRateThreshold: 50, minimumCalls: 3, timeout: 1000, resetTimeout: 500 };

    const answered = createCircuitBreaker(policy, timing, outcome);
    for (const message of ['not-found', 'not-found', 'down']) {
      await expect(answered.execute(() => Promise.reject(new Error(message)))).rejects.toThrow(
        message,
      );
    }
    // One failure in three calls: closed.
    await expect(answered.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');

    const left = createCircuitBreaker(policy, timing, outcome);
    for (const message of ['aborted', 'aborted', 'down', 'down']) {
      await expect(left.execute(() => Promise.reject(new Error(message)))).rejects.toThrow(message);
    }
    // Aborts did not count toward minimumCalls: two calls, so still closed.
    await expect(left.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('a failed probe then a refused call reports one failure in the window', async () => {
    let timeNow = 0;
    const timing: IClientTiming = { now: () => timeNow, sleep: () => Promise.resolve() };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 10_000, resetTimeout: 500 },
      timing,
      () => 'failure',
    );
    await expect(cb.execute(() => Promise.reject(new Error('a')))).rejects.toThrow('a');
    await expect(cb.execute(() => Promise.reject(new Error('b')))).rejects.toThrow('b');
    timeNow = 600;
    await expect(cb.execute(() => Promise.reject(new Error('probe')))).rejects.toThrow('probe');
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      new ClientCircuitOpenError('Circuit breaker open for origin; 1 failures in window'),
    );
  });

  it('a probe rejected with a success outcome leaves the circuit probeable', async () => {
    let timeNow = 0;
    const timing: IClientTiming = { now: () => timeNow, sleep: () => Promise.resolve() };
    const cb = createCircuitBreaker(
      { threshold: 1, timeout: 10_000, resetTimeout: 500 },
      timing,
      (error) => (error instanceof Error && error.message === 'not-found' ? 'success' : 'failure'),
    );
    await expect(cb.execute(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    timeNow = 600;
    await expect(cb.execute(() => Promise.reject(new Error('not-found')))).rejects.toThrow(
      'not-found',
    );
    // Not closed by the 4xx probe and not reopened: the next call is a probe.
    await expect(cb.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
