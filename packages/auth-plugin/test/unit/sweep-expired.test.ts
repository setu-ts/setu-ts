import { describe, expect, it, vi } from 'vitest';
import { sweepExpired } from '../../src/stores/sweep-expired.ts';

describe('sweepExpired', () => {
  it('leaves entries and the threshold untouched below threshold without calling the predicate', () => {
    const entries = new Map([
      ['expired', 0],
      ['live', 1],
    ]);
    const before = new Map(entries);
    const isExpired = vi.fn((entry: number) => entry === 0);

    expect(sweepExpired(entries, 4_096, isExpired)).toBe(4_096);
    expect(entries).toEqual(before);
    expect(isExpired).not.toHaveBeenCalled();
  });

  it('removes only expired entries at threshold and doubles the surviving size', () => {
    const entries = new Map(Array.from({ length: 2_048 }, (_, i) => [`key-${i}`, i] as const));
    const survivors = new Map([...entries].filter(([, value]) => value >= 512));

    expect(sweepExpired(entries, 2_048, (entry) => entry < 512)).toBe(3_072);
    expect(entries).toEqual(survivors);
  });

  it.each([0, 1])('keeps the 1,024 floor with %i survivors', (survivors) => {
    const entries = new Map(Array.from({ length: 1_024 }, (_, i) => [`key-${i}`, i] as const));

    expect(sweepExpired(entries, 1_024, (entry) => entry >= survivors)).toBe(1_024);
    expect(entries).toEqual(new Map(survivors === 0 ? [] : [['key-0', 0]]));
  });
});
