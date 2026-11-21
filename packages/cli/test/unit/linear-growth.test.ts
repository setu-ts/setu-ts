/** The growth assertion must pass a linear scan and refuse a quadratic one. */
import { describe, expect, it } from 'vitest';

import { expectLinearGrowth } from '../fixtures/linear-growth.ts';

/** `steps` iterations of work the engine cannot remove. */
function spin(steps: number): number {
  let sum = 0;
  for (let step = 0; step < steps; step++) sum = (sum + step * 31) % 1_000_003;
  return sum;
}

describe('expectLinearGrowth', () => {
  it('passes work that grows with its input', () => {
    expect(() => expectLinearGrowth('linear', (size) => () => spin(size), 2_000_000)).not.toThrow();
  });
  it('refuses work that grows with the square of its input, naming every attempt', () => {
    expect(() => expectLinearGrowth('quadratic', (size) => () => spin(size * size), 1_000)).toThrow(
      /^quadratic: 4x the input took \d+\.\d, \d+\.\d, \d+\.\d times as long in 3 attempts/,
    );
  });
  it('builds each input once, outside the timer', () => {
    const built: number[] = [];
    expectLinearGrowth(
      'builds',
      (size) => {
        built.push(size);
        return () => spin(size);
      },
      1_000_000,
    );
    expect(built).toEqual([1_000_000, 4_000_000]);
  });
});
