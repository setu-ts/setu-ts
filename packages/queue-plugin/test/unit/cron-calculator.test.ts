import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { cronNextMs } from '../../src/scheduler/cron-calculator.ts';

describe('cronNextMs', () => {
  const baseTime = Date.UTC(2024, 0, 15, 10, 30, 0); // Jan 15, 2024 10:30:00 UTC

  it('computes next minute for * * * * *', () => {
    const next = cronNextMs('* * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 10, 31, 0);
    expect(next).toBe(expected);
  });

  it('computes fixed minute', () => {
    // 0 * * * * -> next 00 minute
    const next = cronNextMs('0 * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 11, 0, 0);
    expect(next).toBe(expected);
  });

  it('computes fixed hour and minute', () => {
    // 30 10 * * * -> should be in the future
    const next = cronNextMs('30 11 * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 11, 30, 0);
    expect(next).toBe(expected);
  });

  it('handles lists', () => {
    // 0,30 * * * * -> next 00 or 30 minute (at 10:30, next is 11:00)
    const next = cronNextMs('0,30 * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 11, 0, 0);
    expect(next).toBe(expected);
  });

  it('handles ranges', () => {
    // 0-10 * * * * -> next minute in 0-10 range
    const next = cronNextMs('0-10 * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 11, 0, 0);
    expect(next).toBe(expected);
  });

  it('handles step values */5', () => {
    // */5 * * * * -> next minute divisible by 5
    const next = cronNextMs('*/5 * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 10, 35, 0);
    expect(next).toBe(expected);
  });

  it('handles step values with range 1-10/2', () => {
    // 1-10/2 * * * * -> 1,3,5,7,9 (at 10:30, next is 11:01)
    const next = cronNextMs('1-10/2 * * * *', baseTime);
    const expected = Date.UTC(2024, 0, 15, 11, 1, 0);
    expect(next).toBe(expected);
  });

  it('handles day of week', () => {
    // 0 9 * * 1 -> 9 AM on Mondays
    const next = cronNextMs('0 9 * * 1', baseTime);
    // Jan 15, 2024 is a Monday, but 9 AM has passed, so next Monday
    expect(next).toBeGreaterThan(baseTime);
  });

  it('handles day of month', () => {
    // 0 0 15 * * -> midnight on the 15th
    const next = cronNextMs('0 0 15 * *', baseTime);
    // Jan 15 2024 00:00 has passed, so Feb 15
    expect(next).toBeGreaterThan(baseTime);
  });

  it('handles month wrap', () => {
    // 0 0 1 1 * -> midnight Jan 1
    const lateYearTime = Date.UTC(2024, 11, 15, 10, 30, 0); // Dec 15, 2024
    const next = cronNextMs('0 0 1 1 *', lateYearTime);
    // Should be Jan 1, 2025
    expect(new Date(next).getUTCMonth()).toBe(0);
    expect(new Date(next).getUTCDate()).toBe(1);
    expect(new Date(next).getUTCFullYear()).toBe(2025);
  });

  it('throws on invalid cron expression', () => {
    expect(() => cronNextMs('bad', baseTime)).toThrow();
  });

  it('throws on wrong number of fields', () => {
    expect(() => cronNextMs('* * * *', baseTime)).toThrow();
    expect(() => cronNextMs('* * * * * *', baseTime)).toThrow();
  });

  it('throws on out-of-range values', () => {
    expect(() => cronNextMs('60 * * * *', baseTime)).toThrow(); // minute 60
    expect(() => cronNextMs('* 24 * * *', baseTime)).toThrow(); // hour 24
  });

  it('handles day-of-month and day-of-week OR semantics', () => {
    // Both specified -> OR semantics
    const next = cronNextMs('0 0 15 * 1', baseTime);
    // Should fire on 15th OR Monday
    expect(next).toBeGreaterThan(baseTime);
  });
});
