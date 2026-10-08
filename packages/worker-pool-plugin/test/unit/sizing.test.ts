import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolveMaxWorkers, validateSizingOptions } from '../../src/services/sizing.ts';
import { WorkerPoolPlugin, WorkerPoolService } from '../../src/index.ts';
import { createFakeRuntime, FakeTimers } from '../fixtures/fakes.ts';

describe('worker sizing', () => {
  for (const value of [NaN, 0, -1, 1.5, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`refuses maxWorkers ${value} at both entry points`, () => {
      const options = { maxWorkers: value };
      for (
        const construct of [
          () => validateSizingOptions(options),
          () => WorkerPoolPlugin(options),
          () => new WorkerPoolService(options, createFakeRuntime(new FakeTimers())),
        ]
      ) {
        expect(construct).toThrow(RangeError);
        expect(construct).toThrow(`received ${value}`);
      }
    });
  }
  it('accepts omitted, positive safe integers and Infinity', () => {
    validateSizingOptions();
    validateSizingOptions({});
    for (const maxWorkers of [1, 64, Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(() => validateSizingOptions({ maxWorkers })).not.toThrow();
    }
  });
  it('resolves parallelism, default size, sum of listed sizes and explicit limits', () => {
    expect(resolveMaxWorkers(undefined, 4)).toBe(4);
    expect(resolveMaxWorkers({ defaultPoolSize: 8 }, 4)).toBe(8);
    expect(resolveMaxWorkers({ pools: { a: { size: 6 }, b: { size: 7 }, c: {} } }, 4)).toBe(13);
    expect(resolveMaxWorkers({ maxWorkers: 1, defaultPoolSize: 8 }, 4)).toBe(1);
    expect(resolveMaxWorkers({ maxWorkers: Infinity }, 4)).toBe(Infinity);
  });
});
