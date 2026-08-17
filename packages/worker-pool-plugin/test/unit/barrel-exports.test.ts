/**
 * Pins the published surface.
 *
 * M45b adds a SIGNAL, not an API: the collector and its metric-name constants
 * are internal, and `src/index.ts` must be unchanged. Without this test a new
 * internal module leaking into the barrel — or an existing export silently
 * dropped — passes every gate, because a re-export file is fully covered
 * merely by being loaded and every other test imports concrete modules
 * (the M56 defect class).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as barrel from '../../src/index.ts';

/** Exactly the value exports M45 shipped. */
const EXPECTED_EXPORTS = [
  'WorkerPoolPlugin',
  'WorkerPoolService',
  'WorkerPoolUnavailableError',
  'WorkerQueueFullError',
  'WorkerTaskError',
  'WorkerTaskTimeoutError',
] as const;

describe('worker-pool-plugin barrel', () => {
  it('should export exactly the documented public surface', () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('should NOT leak the internal metrics surface', () => {
    const names = Object.keys(barrel);
    expect(names).not.toContain('WorkerPoolCollector');
    expect(names).not.toContain('WORKER_POOL_METRICS');
    expect(names).not.toContain('TaskPool');
  });
});
