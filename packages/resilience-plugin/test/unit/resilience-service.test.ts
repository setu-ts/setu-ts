import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { CircuitBreakerPolicy } from '@hono-enterprise/common';
import { ResilienceService } from '../../src/services/resilience-service.ts';
import { BulkheadFullError, CircuitOpenError, TimeoutError } from '../../src/errors.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const CB: CircuitBreakerPolicy = { threshold: 3, timeout: 1000, resetTimeout: 5000 };
const boom = () => Promise.reject(new Error('boom'));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function expectReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('ResilienceService.wrap', () => {
  it('returns a callable that passes through when no patterns are selected', async () => {
    const service = new ResilienceService(new FakeRuntime());
    const guarded = service.wrap(() => Promise.resolve('plain'));
    expect(await guarded()).toBe('plain');
  });

  it('treats explicit false the same as absent (no layer)', async () => {
    const service = new ResilienceService(new FakeRuntime());
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return Promise.resolve('x');
    }, { circuitBreaker: false, retry: false, bulkhead: false });
    expect(await guarded()).toBe('x');
    expect(calls).toBe(1);
  });

  it('shares one circuit breaker across invocations (state persists)', async () => {
    const service = new ResilienceService(new FakeRuntime());
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return boom();
    }, { circuitBreaker: CB });

    // Three failing calls trip the shared breaker.
    for (let i = 0; i < 3; i++) await expectReject(guarded());
    expect(calls).toBe(3);

    // The 4th call fails fast without invoking fn — proving shared state.
    const err = await expectReject(guarded());
    expect(err instanceof CircuitOpenError).toBe(true);
    expect(calls).toBe(3);
  });

  it('resolves circuitBreaker: true from defaultCircuitBreaker', async () => {
    const service = new ResilienceService(new FakeRuntime(), { defaultCircuitBreaker: CB });
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return boom();
    }, { circuitBreaker: true });
    for (let i = 0; i < 3; i++) await expectReject(guarded());
    const err = await expectReject(guarded());
    expect(err instanceof CircuitOpenError).toBe(true);
    expect(calls).toBe(3);
  });

  it('resolves retry: true from defaultRetry', async () => {
    const runtime = new FakeRuntime();
    const service = new ResilienceService(runtime, {
      defaultRetry: { limit: 3, delay: 10, backoff: 'fixed' },
    });
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return calls < 3 ? boom() : Promise.resolve('ok');
    }, { retry: true });
    expect(await guarded()).toBe('ok');
    expect(calls).toBe(3);
    expect(runtime.armedDelays).toEqual([10, 10]);
  });

  it('resolves bulkhead: true from defaultBulkhead', async () => {
    const service = new ResilienceService(new FakeRuntime(), {
      defaultBulkhead: { maxConcurrent: 1, maxQueue: 0 },
    });
    const d1 = deferred<string>();
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return d1.promise;
    }, { bulkhead: true });

    const p1 = guarded();
    const err = await expectReject(guarded());
    expect(err instanceof BulkheadFullError).toBe(true);
    d1.resolve('done');
    expect(await p1).toBe('done');
    expect(calls).toBe(1);
  });

  it('throws when circuitBreaker: true has no defaultCircuitBreaker', () => {
    const service = new ResilienceService(new FakeRuntime());
    expect(() => service.wrap(boom, { circuitBreaker: true })).toThrow(
      'circuitBreaker: true requires defaultCircuitBreaker',
    );
  });

  it('throws when retry: true has no defaultRetry', () => {
    const service = new ResilienceService(new FakeRuntime());
    expect(() => service.wrap(boom, { retry: true })).toThrow(
      'retry: true requires defaultRetry',
    );
  });

  it('throws when bulkhead: true has no defaultBulkhead', () => {
    const service = new ResilienceService(new FakeRuntime());
    expect(() => service.wrap(boom, { bulkhead: true })).toThrow(
      'bulkhead: true requires defaultBulkhead',
    );
  });

  it('short-circuits: an open breaker stops retry and fn (call-count frozen)', async () => {
    const service = new ResilienceService(new FakeRuntime());
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return boom();
    }, {
      circuitBreaker: { threshold: 1, timeout: 1000, resetTimeout: 5000 },
      retry: { limit: 3, delay: 1, backoff: 'fixed' },
      timeout: 50,
    });

    // First invocation: retry runs 3 attempts, the whole retry counts as ONE
    // breaker failure, tripping the threshold-1 breaker open.
    await expectReject(guarded());
    expect(calls).toBe(3);

    // Second invocation: breaker open → fails fast, retry and fn never run.
    const err = await expectReject(guarded());
    expect(err instanceof CircuitOpenError).toBe(true);
    expect(calls).toBe(3);
  });

  it('short-circuits: a full bulkhead leaves the breaker and fn untouched', async () => {
    const service = new ResilienceService(new FakeRuntime());
    const d1 = deferred<string>();
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      return d1.promise;
    }, {
      bulkhead: { maxConcurrent: 1, maxQueue: 0 },
      circuitBreaker: { threshold: 1, timeout: 1000, resetTimeout: 5000 },
    });

    const p1 = guarded(); // occupies the only slot; fn entered (calls === 1)
    const err = await expectReject(guarded()); // shed before breaker/fn
    expect(err instanceof BulkheadFullError).toBe(true);
    expect(calls).toBe(1);

    d1.resolve('ok');
    expect(await p1).toBe('ok');
  });

  it('gives each retry attempt its own timeout, so a slow attempt is retried', async () => {
    const service = new ResilienceService(new FakeRuntime());
    let calls = 0;
    const guarded = service.wrap(() => {
      calls++;
      // First attempt hangs (times out); second resolves promptly.
      return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('recovered');
    }, {
      retry: { limit: 2, delay: 1, backoff: 'fixed' },
      timeout: 5,
    });
    expect(await guarded()).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('a bare timeout layer rejects a hanging call with TimeoutError', async () => {
    const service = new ResilienceService(new FakeRuntime());
    const guarded = service.wrap(() => new Promise<string>(() => {}), { timeout: 5 });
    const err = await expectReject(guarded());
    expect(err instanceof TimeoutError).toBe(true);
  });
});
