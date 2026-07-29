/**
 * Tests for `createClient()` factory.
 *
 * Covers defaults, injected timing, and validation errors.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createClient } from '../../src/sdk.ts';
import { HttpClientError } from '../../src/errors.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

const fakeTiming: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };

describe('createClient', () => {
  it('creates a client with required baseUrl', () => {
    const client = createClient({ baseUrl: 'https://api.example.com' });
    expect(typeof client.request).toEqual('function');
  });

  it('uses injected timing for retry backoff', async () => {
    // Asserting `typeof client.request === 'function'` proves nothing about
    // wiring — it is true whether or not the seam was passed through. Drive the
    // seam instead and observe the recorded sleeps.
    const sleeps: number[] = [];
    const timing: IClientTiming = {
      now: () => 0,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
    const client = createClient({
      baseUrl: 'https://api.example.com',
      timing,
      retry: { limit: 3, delay: 25, backoff: 'exponential' },
      fetch: () => Promise.resolve(new Response('', { status: 503 })),
    });

    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(HttpClientError);
    expect(sleeps).toEqual([25, 50]);
  });

  it('defaults timing to a working implementation when omitted', async () => {
    // The regression this guards: `HttpClient` used to read `options.timing!`, so
    // if `createClient` stopped supplying the default, retry threw
    // `TypeError: Cannot read properties of undefined (reading 'sleep')` instead
    // of retrying. Nothing in the suite exercised that path.
    let attempts = 0;
    const client = createClient({
      baseUrl: 'https://api.example.com',
      retry: { limit: 2, delay: 1, backoff: 'fixed' },
      fetch: () => {
        attempts++;
        return Promise.resolve(new Response('', { status: 503 }));
      },
    });

    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(HttpClientError);
    // Two attempts means the default timing's `sleep` really ran between them.
    expect(attempts).toEqual(2);
  });

  it('applies default headers and the injected fetch', async () => {
    let seenAuth: string | null = null;
    let seenUrl = '';
    const client = createClient({
      baseUrl: 'https://api.example.com/v1/',
      headers: { Authorization: 'Bearer configured' },
      timing: fakeTiming,
      fetch: (input, init) => {
        seenUrl = String(input);
        seenAuth = new Headers(init?.headers).get('authorization');
        return Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });

    const res = await client.request<{ ok: boolean }>({ method: 'GET', path: 'users' });
    expect(seenAuth).toBe('Bearer configured');
    expect(seenUrl).toBe('https://api.example.com/v1/users');
    expect(res.data).toEqual({ ok: true });
  });

  it('honors a configured rate limit through the factory', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const timing: IClientTiming = {
      now: () => clock,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    };
    const client = createClient({
      baseUrl: 'https://api.example.com',
      timing,
      rateLimit: { maxRequests: 1, windowMs: 1000 },
      fetch: () =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
    });

    await client.request({ method: 'GET', path: 'a' });
    await client.request({ method: 'GET', path: 'b' });
    // The second request waited out the window rather than going straight through.
    expect(sleeps).toEqual([1000]);
  });

  it('throws when retry.limit < 1', () => {
    expect(() =>
      createClient({
        baseUrl: 'https://api.example.com',
        retry: { limit: 0, delay: 100, backoff: 'fixed' },
      })
    ).toThrow('retry.limit must be >= 1');
  });

  it('throws when circuitBreaker.threshold < 1', () => {
    expect(() =>
      createClient({
        baseUrl: 'https://api.example.com',
        circuitBreaker: { threshold: 0, timeout: 30_000, resetTimeout: 10_000 },
      })
    ).toThrow('circuitBreaker.threshold must be >= 1');
  });

  it('throws when rateLimit.maxRequests < 1', () => {
    expect(() =>
      createClient({
        baseUrl: 'https://api.example.com',
        rateLimit: { maxRequests: 0, windowMs: 10_000 },
      })
    ).toThrow('rateLimit.maxRequests must be >= 1');
  });

  it('throws when rateLimit.windowMs <= 0', () => {
    expect(() =>
      createClient({
        baseUrl: 'https://api.example.com',
        rateLimit: { maxRequests: 5, windowMs: 0 },
      })
    ).toThrow('rateLimit.windowMs must be > 0');
  });

  it('accepts valid retry policy', () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      retry: { limit: 3, delay: 100, backoff: 'exponential' },
    });
    expect(typeof client.request).toEqual('function');
  });

  it('accepts valid circuit breaker policy', () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      circuitBreaker: { threshold: 5, timeout: 30_000, resetTimeout: 10_000 },
    });
    expect(typeof client.request).toEqual('function');
  });

  it('accepts valid rate limit policy', () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    });
    expect(typeof client.request).toEqual('function');
  });
});
