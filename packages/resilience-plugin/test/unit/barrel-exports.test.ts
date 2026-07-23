import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as mod from '../../src/index.ts';

describe('resilience-plugin barrel', () => {
  it('exports the public surface', () => {
    expect(typeof mod.ResiliencePlugin).toBe('function');
    expect(typeof mod.TimeoutError).toBe('function');
    expect(typeof mod.BulkheadFullError).toBe('function');
    expect(typeof mod.CircuitOpenError).toBe('function');
  });

  it('does not leak internal implementation symbols', () => {
    const keys = Object.keys(mod);
    for (
      const internal of [
        'ResilienceService',
        'CircuitBreaker',
        'Bulkhead',
        'runWithRetry',
        'runWithTimeout',
        'computeBackoffMs',
      ]
    ) {
      expect(keys.includes(internal)).toBe(false);
    }
  });

  it('exports exactly the intended runtime symbols', () => {
    expect(Object.keys(mod).sort()).toEqual(
      ['BulkheadFullError', 'CircuitOpenError', 'ResiliencePlugin', 'TimeoutError'],
    );
  });
});
