/**
 * Unit tests for the ONE indicator-result trust rule shared by the `/health`
 * report and the observation collector. The accepted and rejected shapes are
 * enumerated as data, so the rule cannot drift from what this file states.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { isHealthStatus, normalizeIndicatorResult } from '../../src/services/health-status.ts';

describe('isHealthStatus', () => {
  it('admits exactly the framework statuses', () => {
    for (const status of ['up', 'degraded', 'down']) {
      expect(isHealthStatus(status)).toBe(true);
    }
    for (const status of ['UP', 'ok', 'healthy', '', null, undefined, 0, 1, {}, ['up']]) {
      expect(isHealthStatus(status)).toBe(false);
    }
  });
});

describe('normalizeIndicatorResult', () => {
  it('projects a framework result to status and object data only', () => {
    const accepted: ReadonlyArray<readonly [unknown, unknown]> = [
      [{ status: 'up' }, { status: 'up' }],
      [{ status: 'degraded', data: { lag: 3 } }, { status: 'degraded', data: { lag: 3 } }],
      [{ status: 'down', data: {} }, { status: 'down', data: {} }],
      // Undeclared fields are dropped; data that is not an object is omitted.
      [{ status: 'up', extra: 'x', latencyMs: 9 }, { status: 'up' }],
      [{ status: 'up', data: 'text' }, { status: 'up' }],
      [{ status: 'up', data: null }, { status: 'up' }],
      [{ status: 'up', data: 7 }, { status: 'up' }],
    ];
    for (const [raw, projected] of accepted) {
      expect(normalizeIndicatorResult(raw)).toEqual(projected);
    }
  });

  it('keeps the data key absent, not undefined, when data is omitted', () => {
    expect('data' in (normalizeIndicatorResult({ status: 'up' }) as object)).toBe(false);
  });

  it('rejects anything that is not a framework result', () => {
    const rejected: readonly unknown[] = [
      null,
      undefined,
      'up',
      0,
      true,
      {},
      { status: 'UP' },
      { status: 'healthy', data: {} },
      { status: { value: 'canary-object-status' } },
      { status: null },
    ];
    for (const raw of rejected) {
      expect(normalizeIndicatorResult(raw)).toBeNull();
    }
  });

  it('lets a throwing status getter propagate to the caller', () => {
    const hostile = {
      get status(): string {
        throw new Error('canary-getter');
      },
    };
    expect(() => normalizeIndicatorResult(hostile)).toThrow('canary-getter');
  });

  it('reads status and data exactly once', () => {
    let statusReads = 0;
    let dataReads = 0;
    const counted = {
      get status() {
        statusReads += 1;
        return 'up';
      },
      get data() {
        dataReads += 1;
        return { n: 1 };
      },
    };
    expect(normalizeIndicatorResult(counted)).toEqual({ status: 'up', data: { n: 1 } });
    expect([statusReads, dataReads]).toEqual([1, 1]);
  });
});
