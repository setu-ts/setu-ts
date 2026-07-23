import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { CircuitBreakerPolicy } from '@hono-enterprise/common';
import { CircuitBreaker } from '../../src/patterns/circuit-breaker.ts';
import { CircuitOpenError } from '../../src/errors.ts';

const POLICY: CircuitBreakerPolicy = { threshold: 3, timeout: 1000, resetTimeout: 5000 };

/** A controllable monotonic clock. */
function clock(start = 0): { now: number; hrtime: () => number } {
  const state = { now: start, hrtime: () => 0 };
  state.hrtime = () => state.now;
  return state;
}

const boom = () => Promise.reject(new Error('boom'));

async function expectReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('CircuitBreaker', () => {
  it('trips closed → open once threshold failures fall inside the window', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    expect(breaker.state).toBe('closed');
    await expectReject(breaker.execute(boom));
    await expectReject(breaker.execute(boom));
    expect(breaker.state).toBe('closed');
    await expectReject(breaker.execute(boom));
    expect(breaker.state).toBe('open');
  });

  it('does not trip when failures are spread beyond the rolling window', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    await expectReject(breaker.execute(boom));
    c.now = 2000;
    await expectReject(breaker.execute(boom));
    c.now = 4000;
    await expectReject(breaker.execute(boom));
    // Each failure aged out the previous ones, so the count never reached 3.
    expect(breaker.state).toBe('closed');
  });

  it('fails fast with CircuitOpenError without invoking fn while open', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    for (let i = 0; i < 3; i++) await expectReject(breaker.execute(boom));
    expect(breaker.state).toBe('open');

    let calls = 0;
    const counted = () => {
      calls++;
      return Promise.resolve('ok');
    };
    c.now = 1000; // < resetTimeout
    const err = await expectReject(breaker.execute(counted));
    expect(err instanceof CircuitOpenError).toBe(true);
    expect(calls).toBe(0);
  });

  it('state getter reports half-open lazily once the cooldown elapses', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    for (let i = 0; i < 3; i++) await expectReject(breaker.execute(boom));
    expect(breaker.state).toBe('open');
    c.now = 4999;
    expect(breaker.state).toBe('open');
    c.now = 5000;
    expect(breaker.state).toBe('half-open');
  });

  it('a successful half-open trial closes the breaker and clears the window', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    for (let i = 0; i < 3; i++) await expectReject(breaker.execute(boom));
    c.now = 5000;
    const result = await breaker.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(breaker.state).toBe('closed');
    // Window cleared: two fresh failures must not trip (would need 3).
    await expectReject(breaker.execute(boom));
    await expectReject(breaker.execute(boom));
    expect(breaker.state).toBe('closed');
  });

  it('a failed half-open trial re-opens and resets the cooldown', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    for (let i = 0; i < 3; i++) await expectReject(breaker.execute(boom));
    c.now = 5000;
    await expectReject(breaker.execute(boom)); // half-open trial fails
    expect(breaker.state).toBe('open');
    // openedAt reset to 5000: still open until 10000.
    c.now = 9999;
    const err = await expectReject(breaker.execute(() => Promise.resolve('x')));
    expect(err instanceof CircuitOpenError).toBe(true);
    c.now = 10000;
    expect(breaker.state).toBe('half-open');
  });

  it('allows only a single half-open probe; concurrent calls fail fast', async () => {
    const c = clock();
    const breaker = new CircuitBreaker(POLICY, c.hrtime);
    for (let i = 0; i < 3; i++) await expectReject(breaker.execute(boom));
    c.now = 5000;

    let release: (v: string) => void = () => {};
    const gated = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });

    const first = breaker.execute(gated); // enters half-open probe, pending
    await Promise.resolve();
    const err = await expectReject(breaker.execute(() => Promise.resolve('second')));
    expect(err instanceof CircuitOpenError).toBe(true);

    release('done');
    expect(await first).toBe('done');
    expect(breaker.state).toBe('closed');
  });
});
