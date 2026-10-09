/**
 * The keyed retry gate (M109b §3.9): a keyed request retries any method, `409`
 * and transport rejections, but never repeats a keyed, non-safe method whose
 * response already arrived.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpClientError } from '../../src/errors.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';
import { markExecuted, runWithRetry } from '../../src/retry/retry-strategy.ts';

/** A no-wait timing recording each sleep. */
function timing(): { timing: IClientTiming; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    timing: {
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

/** An `HttpClientError` for a status. */
function httpError(status: number): HttpClientError {
  return new HttpClientError(`HTTP ${status}`, status, new Headers(), undefined);
}

/** A function that rejects `statuses[n]` for the first calls, then resolves. */
function scripted(statuses: readonly number[], value = 'ok') {
  let call = 0;
  return {
    calls: () => call,
    fn: () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call++;
      return status === 200 ? Promise.resolve(value) : Promise.reject(httpError(status));
    },
  };
}

describe('runWithRetry keyed gate (M109b §3.9)', () => {
  it('retries a keyed POST on 5xx', async () => {
    const { timing: t, sleeps } = timing();
    const { fn, calls } = scripted([500, 500, 200]);
    expect(
      await runWithRetry(fn, { limit: 3, delay: 5, backoff: 'fixed' }, 'POST', t, undefined, true),
    )
      .toBe('ok');
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  it('retries a keyed 409, and an unkeyed 409 not at all', async () => {
    const first = timing();
    const keyed = scripted([409, 200], 'done');
    expect(
      await runWithRetry(
        keyed.fn,
        { limit: 2, delay: 5, backoff: 'fixed' },
        'POST',
        first.timing,
        undefined,
        true,
      ),
    )
      .toBe('done');

    const second = timing();
    const unkeyed = scripted([409, 200]);
    await expect(
      runWithRetry(unkeyed.fn, { limit: 2, delay: 5, backoff: 'fixed' }, 'POST', second.timing),
    ).rejects.toBeInstanceOf(HttpClientError);
    expect(unkeyed.calls()).toBe(1);
  });

  it('retries a keyed transport rejection on a non-safe method', async () => {
    const { timing: t } = timing();
    let calls = 0;
    const result = await runWithRetry(
      () => {
        calls++;
        return calls < 2 ? Promise.reject(new Error('network')) : Promise.resolve('ok');
      },
      { limit: 2, delay: 5, backoff: 'fixed' },
      'POST',
      t,
      undefined,
      true,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('never retries a keyed non-safe method after a response arrived', async () => {
    const { timing: t } = timing();
    let calls = 0;
    await expect(
      runWithRetry(
        () => {
          calls++;
          return Promise.reject(markExecuted(new Error('bad JSON body')));
        },
        { limit: 3, delay: 5, backoff: 'fixed' },
        'POST',
        t,
        undefined,
        true,
      ),
    ).rejects.toThrow('bad JSON body');
    expect(calls).toBe(1);
  });

  it('leaves an unkeyed GET post-response error retryable as before', async () => {
    const { timing: t } = timing();
    let calls = 0;
    const result = await runWithRetry(
      () => {
        calls++;
        return calls < 2
          ? Promise.reject(markExecuted(new Error('transient interceptor')))
          : Promise.resolve('ok');
      },
      { limit: 2, delay: 5, backoff: 'fixed' },
      'GET',
      t,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('still lets an abort win over the keyed gate', async () => {
    const { timing: t } = timing();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      runWithRetry(
        () => {
          calls++;
          return Promise.reject(httpError(500));
        },
        { limit: 3, delay: 5, backoff: 'fixed' },
        'POST',
        t,
        controller.signal,
        true,
      ),
    ).rejects.toBeInstanceOf(HttpClientError);
    expect(calls).toBe(1);
  });
});
