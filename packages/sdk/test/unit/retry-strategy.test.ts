/**
 * Tests for internal retry strategy.
 *
 * Covers backoff values, method classification, status-class decisions,
 * Retry-After delta-seconds parsing, abort non-retry, and error propagation.
 *
 * Uses `HttpClientError` (the real error type emitted by `HttpClient`) rather
 * than raw `Response` rejections, so the tests exercise the live classification
 * path.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { runWithRetry } from '../../src/retry/retry-strategy.ts';
import { HttpClientError } from '../../src/errors.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

function createTiming(): { timing: IClientTiming; sleepCalls: Array<{ ms: number }> } {
  const sleepCalls: Array<{ ms: number }> = [];
  const timing: IClientTiming = {
    now: () => 0,
    sleep: (ms) => {
      sleepCalls.push({ ms });
      return Promise.resolve();
    },
  };
  return { timing, sleepCalls };
}

function httpError(status: number, headers: Record<string, string> = {}): HttpClientError {
  return new HttpClientError(`HTTP ${status}`, status, new Headers(headers), undefined);
}

describe('runWithRetry', () => {
  it('returns result on first success', async () => {
    const { timing, sleepCalls } = createTiming();
    const result = await runWithRetry(
      () => Promise.resolve(42),
      { limit: 3, delay: 100, backoff: 'fixed' },
      'GET',
      timing,
    );
    expect(result).toEqual(42);
    expect(sleepCalls).toEqual([]);
  });

  it('retries on transport rejection (GET)', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error('network'));
      return Promise.resolve('ok');
    };
    const result = await runWithRetry(fn, { limit: 3, delay: 50, backoff: 'fixed' }, 'GET', timing);
    expect(result).toEqual('ok');
    expect(sleepCalls.length).toEqual(2);
    expect(sleepCalls[0].ms).toEqual(50);
    expect(sleepCalls[1].ms).toEqual(50);
  });

  it('uses exponential backoff', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error('network'));
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 3, delay: 100, backoff: 'exponential' }, 'GET', timing);
    expect(sleepCalls[0].ms).toEqual(100); // 100 * 2^0
    expect(sleepCalls[1].ms).toEqual(200); // 100 * 2^1
  });

  it('does not retry unsafe method (POST)', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      return Promise.reject(new Error('network'));
    };
    await expect(
      runWithRetry(fn, { limit: 3, delay: 10, backoff: 'fixed' }, 'POST', timing),
    ).rejects.toThrow('network');
    expect(attempts).toEqual(1);
  });

  it('does not retry PATCH method', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      return Promise.reject(new Error('network'));
    };
    await expect(
      runWithRetry(fn, { limit: 3, delay: 10, backoff: 'fixed' }, 'PATCH', timing),
    ).rejects.toThrow('network');
    expect(attempts).toEqual(1);
  });

  it('retries 5xx status', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) return Promise.reject(httpError(500));
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    expect(attempts).toEqual(2);
  });

  it('does not retry 4xx non-retryable status (400)', async () => {
    const { timing } = createTiming();
    const fn = () => Promise.reject(httpError(400));
    await expect(
      runWithRetry(fn, { limit: 3, delay: 10, backoff: 'fixed' }, 'GET', timing),
    ).rejects.toBeInstanceOf(HttpClientError);
  });

  it('honors Retry-After delta-seconds', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(httpError(429, { 'Retry-After': '3' }));
      }
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    // Retry-After: 3 → 3000ms, overrides base delay of 10.
    expect(sleepCalls[0].ms).toEqual(3000);
  });

  it('honors Retry-After delta-seconds of 30 (30000ms)', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(httpError(429, { 'Retry-After': '30' }));
      }
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    expect(sleepCalls[0].ms).toEqual(30000);
  });

  it('ignores HTTP-date Retry-After (falls back to computed backoff)', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(
          httpError(429, { 'Retry-After': 'Wed, 21 Oct 2025 07:28:00 GMT' }),
        );
      }
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 42, backoff: 'fixed' }, 'GET', timing);
    expect(sleepCalls[0].ms).toEqual(42);
  });

  it('rejects fractional Retry-After (falls back to computed backoff)', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(httpError(429, { 'Retry-After': '3.5' }));
      }
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 42, backoff: 'fixed' }, 'GET', timing);
    expect(sleepCalls[0].ms).toEqual(42);
  });

  it('rejects empty Retry-After (falls back to computed backoff)', async () => {
    const { timing, sleepCalls } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(httpError(429, { 'Retry-After': '' }));
      }
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 42, backoff: 'fixed' }, 'GET', timing);
    expect(sleepCalls[0].ms).toEqual(42);
  });

  it('does not retry when abort signal is fired', async () => {
    const { timing } = createTiming();
    const controller = new AbortController();
    const fn = () => {
      controller.abort();
      return Promise.reject(new Error('network'));
    };
    await expect(
      runWithRetry(fn, { limit: 3, delay: 10, backoff: 'fixed' }, 'GET', timing, controller.signal),
    ).rejects.toThrow('network');
  });

  it('propagates last error when all attempts exhausted', async () => {
    const { timing } = createTiming();
    const fn = () => Promise.reject(new Error('persistent failure'));
    await expect(
      runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing),
    ).rejects.toThrow('persistent failure');
  });

  it('retries 408 status', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) return Promise.reject(httpError(408));
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    expect(attempts).toEqual(2);
  });

  it('retries 425 status', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) return Promise.reject(httpError(425));
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    expect(attempts).toEqual(2);
  });

  it('retries 429 status', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) return Promise.reject(httpError(429));
      return Promise.resolve('ok');
    };
    await runWithRetry(fn, { limit: 2, delay: 10, backoff: 'fixed' }, 'GET', timing);
    expect(attempts).toEqual(2);
  });

  it('non-retryable 4xx (403) does not retry', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fn = () => {
      attempts++;
      return Promise.reject(httpError(403));
    };
    await expect(
      runWithRetry(fn, { limit: 3, delay: 10, backoff: 'fixed' }, 'GET', timing),
    ).rejects.toBeInstanceOf(HttpClientError);
    expect(attempts).toEqual(1);
  });
});
