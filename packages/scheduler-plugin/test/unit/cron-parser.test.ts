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

  // --- Additional coverage for uncovered lines ---

  it('throws on invalid step range (start below min)', () => {
    expect(() => cronNextMs('-1-30/10 * * * *', base)).toThrow();
  });

  it('throws on invalid step range (end above max)', () => {
    expect(() => cronNextMs('0-60/10 * * * *', base)).toThrow();
  });

  it('throws on invalid list value below min', () => {
    expect(() => cronNextMs('-1,0 * * * *', base)).toThrow();
  });

  it('throws on invalid list value above max', () => {
    expect(() => cronNextMs('60,0 * * * *', base)).toThrow();
  });

  it('throws on single value below min', () => {
    expect(() => cronNextMs('-1 * * * *', base)).toThrow();
  });

  it('throws on invalid day-of-month (0)', () => {
    expect(() => cronNextMs('* * 0 * *', base)).toThrow();
  });

  it('throws on invalid day-of-month (32)', () => {
    expect(() => cronNextMs('* * 32 * *', base)).toThrow();
  });

  it('throws on invalid month (0)', () => {
    expect(() => cronNextMs('* * * 0 *', base)).toThrow();
  });

  it('throws on invalid month (13)', () => {
    expect(() => cronNextMs('* * * 13 *', base)).toThrow();
  });

  it('handles exact match at next minute', () => {
    const result = cronNextMs('* * * * *', base);
    // Must be strictly after base
    expect(result).toBeGreaterThan(base);
    // Must be at most one minute later
    expect(result - base).toBeLessThanOrEqual(60000);
  });

  it('handles year rollover for month constraint', () => {
    // Start at December and target January
    const decBase = new Date(Date.UTC(2024, 11, 15, 10, 30)).getTime();
    const result = cronNextMs('0 0 1 1 *', decBase);
    // Should be Jan 1, 2025
    const jan2025 = new Date(Date.UTC(2025, 0, 1, 0, 0)).getTime();
    expect(result).toBe(jan2025);
  });

  it('handles fixed minute and fixed hour with no current match', () => {
    // Start at 10:30, target 08:00 — should roll to next day
    const start = new Date(Date.UTC(2024, 0, 15, 10, 30)).getTime();
    const result = cronNextMs('0 8 * * *', start);
    const next8am = new Date(Date.UTC(2024, 0, 16, 8, 0)).getTime();
    expect(result).toBe(next8am);
  });

  it('handles DOM specified (not *) with match', () => {
    const start = new Date(Date.UTC(2024, 0, 14, 23, 30)).getTime();
    const result = cronNextMs('0 0 15 * *', start);
    const jan15 = new Date(Date.UTC(2024, 0, 15, 0, 0)).getTime();
    expect(result).toBe(jan15);
  });

  it('handles DOW specified (not *) with match', () => {
    const result = cronNextMs('0 0 * * 1', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles both DOM and DOW specified (OR semantics), DOM matches first', () => {
    // DOM = 15, DOW = 1 (Monday) — fires on whichever comes first
    const result = cronNextMs('0 0 15 * 1', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles step-only for hour field', () => {
    const result = cronNextMs('0 */6 * * *', base);
    expect(result).toBeGreaterThan(base);
  });

  it('handles range with step for day-of-month', () => {
    const result = cronNextMs('0 0 1-15/5 * *', base);
    expect(result).toBeGreaterThan(base);
  });
});
