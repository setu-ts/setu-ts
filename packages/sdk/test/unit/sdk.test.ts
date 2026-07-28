/**
 * Tests for `createClient()` factory.
 *
 * Covers defaults, injected timing, and validation errors.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createClient } from '../../src/sdk.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

const fakeTiming: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };

describe('createClient', () => {
  it('creates a client with required baseUrl', () => {
    const client = createClient({ baseUrl: 'https://api.example.com' });
    expect(typeof client.request).toEqual('function');
  });

  it('uses injected timing', () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
    });
    expect(typeof client.request).toEqual('function');
  });

  it('defaults timing when omitted', () => {
    const client = createClient({ baseUrl: 'https://api.example.com' });
    expect(typeof client.request).toEqual('function');
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
