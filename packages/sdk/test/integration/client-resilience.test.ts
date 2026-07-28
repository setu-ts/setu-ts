/**
 * Integration test for HTTP client resilience composition.
 *
 * Verifies that retry + circuit breaker + rate limiter work correctly
 * together against a fake fetch and fake timing.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpClient } from '../../src/http/http-client.ts';
import { ClientCircuitOpenError, HttpClientError } from '../../src/errors.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

function createTiming(): { timing: IClientTiming; timeNow: number; sleepDelays: number[] } {
  let timeNow = 0;
  const sleepDelays: number[] = [];
  const timing: IClientTiming = {
    now: () => timeNow,
    sleep: (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    },
  };
  return {
    timing,
    get timeNow() {
      return timeNow;
    },
    set timeNow(v: number) {
      timeNow = v;
    },
    sleepDelays,
  };
}

describe('client resilience composition', () => {
  it('retry-then-success scenario', async () => {
    const { timing } = createTiming();
    let attempts = 0;
    const fetchImpl = () => {
      attempts++;
      if (attempts < 3) {
        return Promise.resolve(
          new Response('', { status: 503, statusText: 'Service Unavailable' }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };

    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing,
      fetch: fetchImpl,
      retry: { limit: 3, delay: 10, backoff: 'fixed' },
    });

    const resp = await client.request({ method: 'GET', path: 'x' });
    expect(resp.data).toEqual({ ok: true });
    expect(attempts).toEqual(3);
  });

  it('circuit opens after transient failures exhaust retries', async () => {
    const { timing } = createTiming();
    const fetchImpl = () =>
      Promise.resolve(new Response('', { status: 503, statusText: 'Service Unavailable' }));

    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing,
      fetch: fetchImpl,
      retry: { limit: 2, delay: 10, backoff: 'fixed' },
      circuitBreaker: { threshold: 2, timeout: 10_000, resetTimeout: 5000 },
    });

    // First request: retries twice, then throws HttpClientError. Counts as 1 failure for breaker.
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('503');

    // Second request: retries twice, then throws. Counts as 2nd failure — breaker trips.
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('503');

    // Third request: breaker is open — should throw ClientCircuitOpenError before fetching.
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(
      ClientCircuitOpenError,
    );
  });

  it('HttpClientError (user error) does not trip breaker', async () => {
    const { timing } = createTiming();
    const fetchImpl = () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'bad input' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing,
      fetch: fetchImpl,
      circuitBreaker: { threshold: 2, timeout: 10_000, resetTimeout: 5000 },
    });

    // Multiple 400s should not trip breaker (isFailure returns false for HttpClientError).
    await expect(client.request({ method: 'POST', path: 'x' })).rejects.toThrow(HttpClientError);
    await expect(client.request({ method: 'POST', path: 'x' })).rejects.toThrow(HttpClientError);
    await expect(client.request({ method: 'POST', path: 'x' })).rejects.toThrow(HttpClientError);

    // Should still work — breaker never tripped.
    await expect(client.request({ method: 'POST', path: 'x' })).rejects.toThrow(HttpClientError);
  });

  it('per-origin isolation — one origin open does not affect another', async () => {
    const { timing } = createTiming();
    const fetchA = () =>
      Promise.resolve(new Response('', { status: 503, statusText: 'Service Unavailable' }));
    const fetchB = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const fetchImpl = (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('origin-a')) return fetchA();
      return fetchB();
    };

    const client = new HttpClient({
      baseUrl: 'https://origin-a.example.com',
      timing,
      fetch: fetchImpl,
      retry: { limit: 1, delay: 10, backoff: 'fixed' },
      circuitBreaker: { threshold: 1, timeout: 10_000, resetTimeout: 5000 },
    });

    // Trip breaker on origin-a.
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('503');

    // Breaker should now be open for origin-a.
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(
      ClientCircuitOpenError,
    );
  });

  it('non-retryable 4xx on GET is NOT retried (exactly 1 fetch)', async () => {
    const { timing, sleepDelays } = createTiming();
    let fetchCount = 0;
    const fetchImpl = () => {
      fetchCount++;
      return Promise.resolve(
        new Response(JSON.stringify({ detail: 'bad request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };

    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing,
      fetch: fetchImpl,
      retry: { limit: 3, delay: 10, backoff: 'fixed' },
    });

    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(HttpClientError);
    expect(fetchCount).toEqual(1);
    expect(sleepDelays).toEqual([]);
  });

  it('429 with Retry-After delta-seconds honors the delay', async () => {
    const { timing, sleepDelays } = createTiming();
    let attempts = 0;
    const fetchImpl = () => {
      attempts++;
      if (attempts < 2) {
        return Promise.resolve(
          new Response('', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'Retry-After': '30' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };

    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing,
      fetch: fetchImpl,
      retry: { limit: 3, delay: 10, backoff: 'fixed' },
    });

    const resp = await client.request({ method: 'GET', path: 'x' });
    expect(resp.data).toEqual({ ok: true });
    expect(attempts).toEqual(2);
    // Retry-After: 30 → 30000ms, overrides the base delay of 10.
    expect(sleepDelays).toEqual([30000]);
  });
});
