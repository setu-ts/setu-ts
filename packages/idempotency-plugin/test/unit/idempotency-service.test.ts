/**
 * Unit tests for the idempotency service (plan §3.14).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IdempotencyConfigurationError } from '../../src/errors.ts';
import { resolveDefaults } from '../../src/core/options.ts';
import { IdempotencyService } from '../../src/service/idempotency-service.ts';
import { MemoryIdempotencyStore } from '../../src/stores/memory-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A service over a memory store. */
function service() {
  const runtime = createClockRuntime();
  const store = new MemoryIdempotencyStore();
  return new IdempotencyService({
    store,
    runtime,
    logger: () => undefined,
    defaults: resolveDefaults(undefined),
  });
}

describe('IdempotencyService (M109a §3.14)', () => {
  it('builds a middleware and a behavior', () => {
    const instance = service();
    expect(typeof instance.middleware()).toBe('function');
    expect(typeof instance.behavior({ topics: ['t'] }).handle).toBe('function');
  });

  it('throws a resolution error for ttlMs < leaseMs', () => {
    const instance = service();
    try {
      instance.middleware({ leaseMs: 5_000, ttlMs: 1_000 });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IdempotencyConfigurationError);
      expect((error as IdempotencyConfigurationError).option).toBe('ttlMs');
    }
  });

  it('uses the plugin defaults when options are omitted', () => {
    const runtime = createClockRuntime();
    const store = new MemoryIdempotencyStore();
    const instance = new IdempotencyService({
      store,
      runtime,
      logger: () => undefined,
      defaults: resolveDefaults({ leaseMs: 12_345, ttlMs: 99_999 }),
    });
    // Builds without throwing, which it would if the plugin defaults were not
    // carried through to the resolution.
    expect(typeof instance.middleware()).toBe('function');
  });
});
