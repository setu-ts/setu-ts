import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { computeBackoffMs } from '../../src/retry/retry-strategy.ts';

describe('computeBackoffMs', () => {
  it('returns base delay for attempt 1', () => {
    expect(computeBackoffMs(1)).toBe(1000);
  });

  it('returns exponential backoff for attempt 2', () => {
    expect(computeBackoffMs(2)).toBe(2000);
  });

  it('returns exponential backoff for attempt 3', () => {
    expect(computeBackoffMs(3)).toBe(4000);
  });

  it('returns exponential backoff for attempt 4', () => {
    expect(computeBackoffMs(4)).toBe(8000);
  });

  it('returns exponential backoff for attempt 5', () => {
    expect(computeBackoffMs(5)).toBe(16000);
  });

  it('caps at maxDelay', () => {
    expect(computeBackoffMs(10)).toBe(30000);
    expect(computeBackoffMs(20)).toBe(30000);
  });

  it('respects custom baseDelay', () => {
    expect(computeBackoffMs(1, 500)).toBe(500);
    expect(computeBackoffMs(2, 500)).toBe(1000);
  });

  it('respects custom maxDelay', () => {
    expect(computeBackoffMs(10, 1000, 5000)).toBe(5000);
  });

  it('computes correct formula: base * 2^(attempts-1)', () => {
    // 1000 * 2^0 = 1000
    expect(computeBackoffMs(1)).toBe(1000);
    // 1000 * 2^1 = 2000
    expect(computeBackoffMs(2)).toBe(2000);
    // 1000 * 2^2 = 4000
    expect(computeBackoffMs(3)).toBe(4000);
    // 1000 * 2^3 = 8000
    expect(computeBackoffMs(4)).toBe(8000);
    // 1000 * 2^4 = 16000
    expect(computeBackoffMs(5)).toBe(16000);
    // 1000 * 2^5 = 32000 -> capped at 30000
    expect(computeBackoffMs(6)).toBe(30000);
  });
});
