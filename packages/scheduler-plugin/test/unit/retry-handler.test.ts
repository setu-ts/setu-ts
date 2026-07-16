/**
 * Tests for computeBackoffMs.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RetryOptions } from '@hono-enterprise/common';
import { computeBackoffMs } from '../../src/retry/retry-handler.ts';

describe('computeBackoffMs', () => {
  it('returns fixed delay for every attempt', () => {
    const retry: RetryOptions = { limit: 3, delay: 1000, backoff: 'fixed' };
    expect(computeBackoffMs(1, retry)).toBe(1000);
    expect(computeBackoffMs(2, retry)).toBe(1000);
    expect(computeBackoffMs(3, retry)).toBe(1000);
    expect(computeBackoffMs(10, retry)).toBe(1000);
  });

  it('returns exponential delay', () => {
    const retry: RetryOptions = { limit: 5, delay: 1000, backoff: 'exponential' };
    expect(computeBackoffMs(1, retry)).toBe(1000); // 1000 * 2^0
    expect(computeBackoffMs(2, retry)).toBe(2000); // 1000 * 2^1
    expect(computeBackoffMs(3, retry)).toBe(4000); // 1000 * 2^2
    expect(computeBackoffMs(4, retry)).toBe(8000); // 1000 * 2^3
  });

  it('handles large attempt numbers', () => {
    const retry: RetryOptions = { limit: 10, delay: 100, backoff: 'exponential' };
    expect(computeBackoffMs(10, retry)).toBe(100 * 2 ** 9);
  });

  it('uses fixed as default when backoff is not exponential', () => {
    const retry: RetryOptions = { limit: 3, delay: 500, backoff: 'fixed' };
    expect(computeBackoffMs(5, retry)).toBe(500);
  });
});
