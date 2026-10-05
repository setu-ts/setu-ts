/**
 * The bounded outbound HTTP collector (M98n §3.1, §3.3, §3.4): the counting
 * table row by row, the snapshot invariants, retention (including the
 * in-flight non-expiry rule and the generation guard), saturation, the
 * collection-failed latch, close/reopen, and the alias rules shared with the
 * `common` realtime collector.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { compileRealtimeDiagnosticsAlias } from '@setu-ts/common';
import type { OutboundHttpDiagnosticsSnapshot } from '@setu-ts/common';

import {
  bump,
  compileOutboundAlias,
  OUTBOUND_ALIAS_ERRORS,
  OUTBOUND_HTTP_LIMITS,
  OutboundHttpCollector,
  statusClassOf,
} from '../../src/diagnostics/outbound-http-observations.ts';

/** A controllable monotonic clock read as a method. */
function fakeClock(start = 1_000): { now(): number; t: number } {
  return {
    t: start,
    now() {
      return this.t;
    },
  };
}

function recordOf(snapshot: OutboundHttpDiagnosticsSnapshot) {
  expect(snapshot.records.length).toBe(1);
  return snapshot.records[0]!;
}

describe('OutboundHttpCollector — counting table (§3.1)', () => {
  it('a begin counts started and leaves every settled counter at zero', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    collector.begin();
    const record = recordOf(collector.snapshot());
    expect(record).toEqual({
      alias: 'payments',
      operation: 'attempt',
      started: 1,
      count: 0,
      responses: 0,
      failures: 0,
      lastStatusClass: null,
      lastDurationMs: null,
      ageMs: 0,
    });
  });

  it('a response counts once with its class and time to headers', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    const token = collector.begin();
    clock.t += 42.9;
    collector.settle(token, true, '4xx');
    const record = recordOf(collector.snapshot());
    expect(record.count).toBe(1);
    expect(record.responses).toBe(1);
    expect(record.failures).toBe(0);
    expect(record.lastStatusClass).toBe('4xx');
    expect(record.lastDurationMs).toBe(42);
  });

  it('a failure counts once and leaves the last status class unchanged', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    collector.settle(collector.begin(), true, '2xx');
    const token = collector.begin();
    clock.t += 5;
    collector.settle(token, false, 'other');
    const record = recordOf(collector.snapshot());
    expect(record.started).toBe(2);
    expect(record.count).toBe(2);
    expect(record.responses).toBe(1);
    expect(record.failures).toBe(1);
    expect(record.lastStatusClass).toBe('2xx');
    expect(record.lastDurationMs).toBe(5);
  });

  it('a null token (nothing recorded) settles to nothing', () => {
    const collector = new OutboundHttpCollector('payments', fakeClock());
    collector.settle(null, true, '2xx');
    expect(collector.snapshot().state).toBe('no-data');
  });
});

describe('OutboundHttpCollector — snapshot states and invariants (§3.3)', () => {
  it('reports no-data before any attempt, then ready, then stale past 30 s', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    expect(collector.snapshot()).toEqual({
      state: 'no-data',
      alias: 'payments',
      coverage: 'owned-instance',
      records: [],
    });
    collector.settle(collector.begin(), true, '2xx');
    clock.t += OUTBOUND_HTTP_LIMITS.staleMs;
    expect(collector.snapshot().state).toBe('ready');
    clock.t += 1;
    expect(collector.snapshot().state).toBe('stale');
  });

  it('returns deeply frozen snapshots with exactly the documented keys', () => {
    const collector = new OutboundHttpCollector('payments', fakeClock());
    collector.settle(collector.begin(), true, '2xx');
    const snapshot = collector.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.keys(snapshot).sort()).toEqual(['alias', 'coverage', 'records', 'state']);
  });

  it('keeps responses + failures === count and count <= started across mixed traffic', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    const pending = [collector.begin(), collector.begin(), collector.begin()];
    collector.settle(pending[0]!, true, '5xx');
    collector.settle(pending[1]!, false, 'other');
    const record = recordOf(collector.snapshot());
    expect(record.responses + record.failures).toBe(record.count);
    expect(record.count).toBeLessThanOrEqual(record.started);
    expect(record.started - record.count).toBe(1);
  });

  it('exposes a frozen source whose only key is snapshot', () => {
    const collector = new OutboundHttpCollector('payments', fakeClock());
    expect(Object.isFrozen(collector.source)).toBe(true);
    expect(Object.keys(collector.source)).toEqual(['snapshot']);
    expect(collector.source.snapshot().state).toBe('no-data');
  });
});

describe('OutboundHttpCollector — retention (§3.4)', () => {
  it('expires an idle record exactly after 60 s and counts afresh', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    collector.settle(collector.begin(), true, '2xx');
    clock.t += OUTBOUND_HTTP_LIMITS.retentionMs;
    expect(collector.snapshot().state).toBe('stale');
    clock.t += 1;
    expect(collector.snapshot().state).toBe('no-data');
    collector.settle(collector.begin(), true, '3xx');
    const record = recordOf(collector.snapshot());
    expect(record.started).toBe(1);
    expect(record.lastStatusClass).toBe('3xx');
  });

  it('never expires a record with an attempt in flight, and it ages into stale', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    const hung = collector.begin();
    clock.t += 10 * OUTBOUND_HTTP_LIMITS.retentionMs;
    const snapshot = collector.snapshot();
    expect(snapshot.state).toBe('stale');
    expect(recordOf(snapshot).started - recordOf(snapshot).count).toBe(1);
    // The hung call finally settles into the SAME record.
    collector.settle(hung, true, '2xx');
    expect(recordOf(collector.snapshot()).count).toBe(1);
  });

  it('discards a settlement from before an expiry, so count never exceeds started', () => {
    const clock = fakeClock();
    const collector = new OutboundHttpCollector('payments', clock);
    const first = collector.begin();
    collector.settle(first, true, '2xx');
    clock.t += OUTBOUND_HTTP_LIMITS.retentionMs + 1;
    const second = collector.begin(); // expires the idle record, new generation
    collector.settle(first, true, '5xx'); // replayed stale token
    const record = recordOf(collector.snapshot());
    expect(record.count).toBe(0);
    expect(record.started).toBe(1);
    collector.settle(second, true, '2xx');
    expect(recordOf(collector.snapshot()).count).toBe(1);
  });

  it('clamps a backward clock to a zero duration and never moves age backwards', () => {
    const clock = fakeClock(5_000);
    const collector = new OutboundHttpCollector('payments', clock);
    const token = collector.begin();
    clock.t = 4_000;
    collector.settle(token, true, '2xx');
    const record = recordOf(collector.snapshot());
    expect(record.lastDurationMs).toBe(0);
    expect(record.ageMs).toBe(0);
  });

  it('saturates every counter at Number.MAX_SAFE_INTEGER', () => {
    expect(bump(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(0)).toBe(1);
  });
});

describe('OutboundHttpCollector — failure latch and lifecycle', () => {
  it('latches collection-failed on a throwing clock and records nothing after', () => {
    let throwing = false;
    const clock = {
      now(): number {
        if (throwing) {
          throw new Error('secret-canary clock');
        }
        return 1;
      },
    };
    const collector = new OutboundHttpCollector('payments', clock);
    const token = collector.begin();
    throwing = true;
    collector.settle(token, true, '2xx');
    throwing = false;
    expect(collector.snapshot()).toEqual({
      state: 'collection-failed',
      alias: 'payments',
      coverage: 'owned-instance',
      records: [],
    });
    expect(collector.begin()).toBe(null);
    expect(JSON.stringify(collector.snapshot())).not.toContain('secret-canary');
  });

  it('latches on a non-finite reading at begin and at snapshot', () => {
    const nan = new OutboundHttpCollector('a', { now: () => Number.NaN });
    expect(nan.begin()).toBe(null);
    expect(nan.snapshot().state).toBe('collection-failed');
    let value = 1;
    const late = new OutboundHttpCollector('b', { now: () => value });
    late.begin();
    value = Number.POSITIVE_INFINITY;
    expect(late.snapshot().state).toBe('collection-failed');
    const typed = new OutboundHttpCollector('c', { now: () => 'x' as unknown as number });
    expect(typed.snapshot().state).toBe('collection-failed');
  });

  it('reads the clock as a method call, preserving its receiver', () => {
    const clock = {
      base: 7,
      now(): number {
        return this.base;
      },
    };
    const collector = new OutboundHttpCollector('payments', clock);
    collector.begin();
    expect(collector.snapshot().state).toBe('ready');
  });

  it('close answers disabled with a null alias and ignores late settlements', () => {
    const collector = new OutboundHttpCollector('payments', fakeClock());
    const token = collector.begin();
    collector.close();
    collector.settle(token, true, '2xx');
    expect(collector.begin()).toBe(null);
    expect(collector.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
    });
    collector.close(); // idempotent
    expect(collector.snapshot().state).toBe('disabled');
  });

  it('reopen revives a closed collector without admitting pre-close tokens', () => {
    const collector = new OutboundHttpCollector('payments', fakeClock());
    const token = collector.begin();
    collector.close();
    collector.reopen();
    collector.settle(token, true, '2xx');
    expect(collector.snapshot().state).toBe('no-data');
    collector.settle(collector.begin(), true, '2xx');
    expect(recordOf(collector.snapshot()).count).toBe(1);
    collector.reopen(); // no-op while open
    expect(recordOf(collector.snapshot()).count).toBe(1);
  });

  it('reopen does not clear a collection-failed latch', () => {
    const collector = new OutboundHttpCollector('payments', { now: () => Number.NaN });
    collector.begin();
    collector.close();
    collector.reopen();
    expect(collector.snapshot().state).toBe('collection-failed');
  });
});

describe('statusClassOf', () => {
  const cases: readonly [unknown, string][] = [
    [200, '2xx'],
    [299, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [599, '5xx'],
    [0, 'other'],
    [101, 'other'],
    [199, 'other'],
    [600, 'other'],
    [200.5, 'other'],
    ['200', 'other'],
    [Number.NaN, 'other'],
    [undefined, 'other'],
  ];
  for (const [status, expected] of cases) {
    it(`maps ${String(status)} to ${expected}`, () => {
      expect(statusClassOf(status)).toBe(expected);
    });
  }
});

describe('compileOutboundAlias — agrees with the common realtime alias rule', () => {
  const table: readonly [unknown, boolean][] = [
    ['payments-api', true],
    ['a', true],
    ['x'.repeat(64), true],
    ['é'.repeat(32), true],
    ['', false],
    ['x'.repeat(65), false],
    ['é'.repeat(33), false],
    ['bad\nalias', false],
    ['bad\u0085alias', false],
    ['tab\talias', false],
    ['bad\u202Ealias', false],
    ['bad\u200Balias', false],
    ['bad\u2028alias', false],
    ['bad\u2029alias', false],
  ];
  for (const [alias, accepted] of table) {
    it(`${accepted ? 'accepts' : 'refuses'} ${JSON.stringify(alias).slice(0, 20)}`, () => {
      const sdk = (() => {
        try {
          compileOutboundAlias(alias);
          return true;
        } catch {
          return false;
        }
      })();
      const common = (() => {
        try {
          compileRealtimeDiagnosticsAlias({ enabled: true, alias: alias as string });
          return true;
        } catch {
          return false;
        }
      })();
      expect(sdk).toBe(accepted);
      expect(common).toBe(accepted);
    });
  }

  it('refuses a non-string with a fixed message that echoes nothing', () => {
    expect(() => compileOutboundAlias(42)).toThrow(OUTBOUND_ALIAS_ERRORS.type);
    try {
      compileOutboundAlias('secret-canary\n');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-canary');
    }
  });
});
