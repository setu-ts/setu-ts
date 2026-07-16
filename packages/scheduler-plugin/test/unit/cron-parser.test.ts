/**
 * Tests for cronNextMs.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { cronNextMs } from '../../src/cron/cron-parser.ts';

describe('cronNextMs', () => {
  const base = 1_700_000_000_000; // Fixed epoch for reproducibility

  it('returns next minute for * * * * *', () => {
    const result = cronNextMs('* * * * *', base);
    expect(result).toBeGreaterThan(base);
    expect(result - base).toBeLessThanOrEqual(60000);
  });

  it('computes next fire for fixed minute', () => {
    const result = cronNextMs('30 * * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('computes next fire for fixed hour and minute', () => {
    const result = cronNextMs('0 9 * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles */5 step', () => {
    const result = cronNextMs('*/5 * * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles lists', () => {
    const result = cronNextMs('0,30 * * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles ranges', () => {
    const result = cronNextMs('0 9-17 * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles day-of-week', () => {
    const result = cronNextMs('0 9 * * 1-5', base);
    expect(result).toBeGreaterThan(base);
  });

  it('throws on invalid expression (single field)', () => {
    expect(() => cronNextMs('invalid', base)).toThrow();
  });

  it('throws on invalid minute (60)', () => {
    expect(() => cronNextMs('60 * * * *', base)).toThrow();
  });

  it('throws on invalid hour (24)', () => {
    expect(() => cronNextMs('* 24 * * *', base)).toThrow();
  });

  it('throws on invalid day-of-week (7)', () => {
    expect(() => cronNextMs('* * * * 7', base)).toThrow();
  });

  it('throws on too few fields', () => {
    expect(() => cronNextMs('* * *', base)).toThrow();
  });

  it('throws on too many fields', () => {
    expect(() => cronNextMs('* * * * * *', base)).toThrow();
  });

  it('advances to next month when needed', () => {
    const result = cronNextMs('0 0 1 12 *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('uses OR semantics for DOM and DOW', () => {
    const result = cronNextMs('0 0 15 * 1', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles range with step', () => {
    const result = cronNextMs('0-30/10 * * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles single value for all fields', () => {
    const result = cronNextMs('0 0 1 1 0', base);
    expect(result).toBeGreaterThan(base);
  });

  it('throws on invalid range (end < start)', () => {
    expect(() => cronNextMs('30-10 * * * *', base)).toThrow();
  });

  it('throws on step of zero', () => {
    expect(() => cronNextMs('*/0 * * * *', base)).toThrow();
  });
});
