/**
 * Tests for the internal circuit breaker.
 *
 * Covers rolling-window trip, open→reject, half-open recovery,
 * injected isFailure predicate arms, and concurrent probe rejection.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
      () => true,
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
      () => true,
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
      () => true,
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

  it('half-open probe failure keeps breaker open', async () => {
    let timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    // timeout > resetTimeout so that after probe fails, old failures are still in window.
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 5000, resetTimeout: 2000 },
      timing,
      () => true,
    );

    // Trip the breaker.
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past resetTimeout (2000) but before timeout (5000) → half-open transition.
    timeNow = 2001;

    // Probe fails — adds a new failure at t=2001.
    await expect(cb.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down',
    );

    // failures now = [0, 0, 2001]. All within timeout window (5000ms).
    // 3 >= threshold(2) → trip. oldest=0, 2002-0=2002 >= resetTimeout(2000) → half-open again.
    timeNow = 2002;
    // Another failing probe confirms the breaker keeps reopening after each failed probe.
    await expect(cb.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down',
    );
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
      () => true,
    );

    // Trip.
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past reset timeout.
    timeNow = 600;

    // Start a probe (simulated by a long-running promise).
    const probePromise = cb.execute(() =>
      new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 50))
    );

    // Concurrent call should be rejected.
    await expect(cb.execute(() => Promise.resolve('concurrent'))).rejects.toThrow(
      ClientCircuitOpenError,
    );

    // Let probe complete.
    const result = await probePromise;
    expect(result).toEqual('ok');
  });

  it('isFailure predicate false does not count as failure', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 500 },
      timing,
      (err: unknown) => !(err instanceof Error && err.message === 'not-counted'),
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

  it('isFailure predicate true counts as failure', async () => {
    const timeNow = 0;
    const timing: IClientTiming = {
      now: () => timeNow,
      sleep: () => Promise.resolve(),
    };
    const cb = createCircuitBreaker(
      { threshold: 2, timeout: 1000, resetTimeout: 500 },
      timing,
      () => true,
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
      () => true,
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
});
