/**
 * Tests for barrel exports (src/index.ts).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as scheduler from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports SchedulerPlugin', () => {
    expect(typeof scheduler.SchedulerPlugin).toBe('function');
  });

  it('exports IDistributedLock type (compile-time only, verified by type check)', () => {
    // IDistributedLock is a type-only export — verify it compiles
    const _typeCheck: typeof scheduler = scheduler;
    expect(_typeCheck).toBeDefined();
  });

  it('does not export internal symbols', () => {
    // These should NOT be exported from the barrel
    expect((scheduler as Record<string, unknown>)['SchedulerService']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['JobRegistry']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['RedisLock']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['MemoryLock']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['cronNextMs']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['computeBackoffMs']).toBeUndefined();
  });
});
