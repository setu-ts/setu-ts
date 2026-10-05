/**
 * The one realtime observation collector (M98l): option validation, the
 * per-kind state and gauge rules, retention, latching, close, clamping and
 * saturation. Declared against the `@setu-ts/common` barrel, so dropping an
 * export fails `deno check`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  IRealtimeDiagnosticsSource,
  IRealtimeObservationCollector,
  RealtimeDiagnosticsOptions,
  RealtimeDiagnosticsResponse,
  RealtimeDiagnosticsSnapshot,
  RealtimeGaugeReading,
  RealtimeObservationCollectorInit,
  RealtimeSourceKind,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  compileRealtimeDiagnosticsAlias,
  createRealtimeObservationCollector,
} from '@setu-ts/common';
import {
  bump,
  REALTIME_COLLECTOR_LIMITS,
  REALTIME_DIAGNOSTICS_ERRORS,
} from '../../src/diagnostics/realtime-observations.ts';

/** A controllable monotonic clock. */
function fakeClock(start = 1_000): { now: number; read: () => number } {
  const clock = { now: start, read: (): number => clock.now };
  return clock;
}

/** A gauge reader over mutable counts, recording how often it was called. */
function fakeGauges(
  openConnections = 0,
  groups = 0,
): {
  reading: { openConnections: number; groups: number };
  calls: number;
  read: () => RealtimeGaugeReading;
} {
  const gauges = {
    reading: { openConnections, groups },
    calls: 0,
    read: (): RealtimeGaugeReading => {
      gauges.calls++;
      return { ...gauges.reading };
    },
  };
  return gauges;
}

function collector(
  kind: RealtimeSourceKind,
  overrides: Partial<RealtimeObservationCollectorInit> = {},
): IRealtimeObservationCollector {
  return createRealtimeObservationCollector({
    kind,
    alias: 'rt',
    clock: () => 1_000,
    gauges: () => ({ openConnections: 0, groups: 0 }),
    ...overrides,
  });
}

function record(snapshot: RealtimeDiagnosticsSnapshot, operation: string) {
  return snapshot.records.find((entry) => entry.operation === operation);
}

describe('M98l common contracts', () => {
  it('exposes the token with the committed kebab-case value', () => {
    expect(CAPABILITIES.REALTIME_DIAGNOSTICS).toEqual('realtime-diagnostics');
  });

  it('the snapshot and response carry exactly the committed keys', () => {
    const source: IRealtimeDiagnosticsSource = collector('sse');
    source satisfies IRealtimeDiagnosticsSource;
    const snapshot = source.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      'alias',
      'coverage',
      'dropped',
      'gauges',
      'records',
      'sourceKind',
      'state',
    ]);
    expect(Object.keys(snapshot.gauges).sort()).toEqual(['groups', 'openConnections', 'state']);
    const response: RealtimeDiagnosticsResponse = {
      version: 1,
      instanceId: 'i',
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot }],
    };
    expect(Object.keys(response).sort()).toEqual(['instanceId', 'sources', 'state', 'version']);
  });

  it('registers a frozen snapshot-only facade, never the collector', () => {
    const ws = collector('websocket');
    expect(Object.keys(ws.source)).toEqual(['snapshot']);
    expect(Object.isFrozen(ws.source)).toBe(true);
    expect(ws.source).toBe(ws.source);
    ws.observe('open', true);
    expect(ws.source.snapshot()).toEqual(ws.snapshot());
  });

  it('a record carries exactly the committed keys', () => {
    const sse = collector('sse');
    sse.observe('close', true);
    expect(Object.keys(sse.snapshot().records[0]!).sort()).toEqual([
      'ageMs',
      'alias',
      'backpressureCloses',
      'count',
      'failed',
      'lastDurationMs',
      'operation',
      'succeeded',
    ]);
  });
});

describe('compileRealtimeDiagnosticsAlias', () => {
  it('returns the approved alias', () => {
    expect(compileRealtimeDiagnosticsAlias({ enabled: true, alias: 'chat' })).toEqual('chat');
    expect(compileRealtimeDiagnosticsAlias({ enabled: true, alias: 'é'.repeat(32) })).toEqual(
      'é'.repeat(32),
    );
  });

  it('refuses every malformed option with a fixed, value-free message', () => {
    const cases: readonly [unknown, string][] = [
      [null, REALTIME_DIAGNOSTICS_ERRORS.shape],
      ['chat', REALTIME_DIAGNOSTICS_ERRORS.shape],
      [['chat'], REALTIME_DIAGNOSTICS_ERRORS.shape],
      [{ enabled: true, alias: 'a', rooms: ['secret'] }, REALTIME_DIAGNOSTICS_ERRORS.extraKey],
      [{ enabled: false, alias: 'a' }, REALTIME_DIAGNOSTICS_ERRORS.enabled],
      [{ enabled: 'true', alias: 'a' }, REALTIME_DIAGNOSTICS_ERRORS.enabled],
      [{ enabled: true, alias: 7 }, REALTIME_DIAGNOSTICS_ERRORS.aliasType],
      [{ enabled: true }, REALTIME_DIAGNOSTICS_ERRORS.aliasType],
      [{ enabled: true, alias: '' }, REALTIME_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ enabled: true, alias: 'x'.repeat(65) }, REALTIME_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ enabled: true, alias: 'é'.repeat(33) }, REALTIME_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ enabled: true, alias: 'a\nb' }, REALTIME_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a\u202eb' }, REALTIME_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a\u0085b' }, REALTIME_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a\u007fb' }, REALTIME_DIAGNOSTICS_ERRORS.aliasControl],
    ];
    for (const [value, message] of cases) {
      expect(() => compileRealtimeDiagnosticsAlias(value as RealtimeDiagnosticsOptions)).toThrow(
        message,
      );
    }
  });

  it('never echoes the refused value', () => {
    try {
      compileRealtimeDiagnosticsAlias({ enabled: true, alias: 'SECRET-\u0007' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });
});

describe('createRealtimeObservationCollector', () => {
  it('refuses an enabled websocket or sse collector without a gauge reader', () => {
    for (const kind of ['websocket', 'sse'] as const) {
      expect(() => createRealtimeObservationCollector({ kind, alias: 'a', clock: () => 0 }))
        .toThrow(REALTIME_DIAGNOSTICS_ERRORS.gauges);
    }
    // A backplane has no gauges, and a disabled collector reads none.
    expect(createRealtimeObservationCollector({ kind: 'backplane', alias: 'a', clock: () => 0 }))
      .toBeDefined();
    expect(createRealtimeObservationCollector({ kind: 'sse', alias: null, clock: () => 0 }))
      .toBeDefined();
  });

  describe('disabled (null alias)', () => {
    it('observes nothing, reads neither clock nor gauges, and answers disabled', async () => {
      let clockReads = 0;
      const gauges = fakeGauges(3, 4);
      const inert = createRealtimeObservationCollector({
        kind: 'websocket',
        alias: null,
        clock: () => {
          clockReads++;
          return 5;
        },
        gauges: gauges.read,
      });
      expect(inert.enabled).toBe(false);
      inert.observe('open', true);
      inert.observe('send', false);
      expect(await inert.observePublish(() => Promise.resolve('passed'))).toEqual('passed');
      const snapshot = inert.snapshot();
      expect(snapshot).toEqual({
        state: 'disabled',
        alias: null,
        sourceKind: 'websocket',
        coverage: 'owned-instance',
        gauges: { state: 'disabled', openConnections: null, groups: null },
        records: [],
        dropped: 0,
      });
      expect(clockReads).toEqual(0);
      expect(gauges.calls).toEqual(0);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.gauges)).toBe(true);
      expect(Object.isFrozen(snapshot.records)).toBe(true);
    });
  });

  describe('websocket and sse', () => {
    it('reports ready with measured zero gauges before any operation', () => {
      for (const kind of ['websocket', 'sse'] as const) {
        const gauges = fakeGauges();
        const source = collector(kind, { gauges: gauges.read });
        expect(source.snapshot()).toEqual({
          state: 'ready',
          alias: 'rt',
          sourceKind: kind,
          coverage: 'owned-instance',
          gauges: { state: 'available', openConnections: 0, groups: 0 },
          records: [],
          dropped: 0,
        });
        expect(gauges.calls).toEqual(1);
      }
    });

    it('counts open, close and send outcomes, in the fixed order, under the one alias', () => {
      const clock = fakeClock();
      const ws = collector('websocket', { clock: clock.read });
      ws.observe('send', true);
      ws.observe('open', true);
      ws.observe('open', false);
      ws.observe('close', false, true); // backpressure ignored for websocket
      ws.observe('send', false);
      clock.now += 7;
      const snapshot = ws.snapshot();
      expect(snapshot.records).toEqual([
        {
          alias: 'rt',
          operation: 'open',
          count: 2,
          lastDurationMs: null,
          ageMs: 7,
          succeeded: 1,
          failed: 1,
          backpressureCloses: null,
        },
        {
          alias: 'rt',
          operation: 'close',
          count: 1,
          lastDurationMs: null,
          ageMs: 7,
          succeeded: 0,
          failed: 1,
          backpressureCloses: null,
        },
        {
          alias: 'rt',
          operation: 'send',
          count: 2,
          lastDurationMs: null,
          ageMs: 7,
          succeeded: 1,
          failed: 1,
          backpressureCloses: null,
        },
      ]);
    });

    it('an sse close record carries 0 backpressure closes until the backlog guard closes one', () => {
      const sse = collector('sse');
      sse.observe('close', true);
      expect(record(sse.snapshot(), 'close')?.backpressureCloses).toEqual(0);
      sse.observe('close', false);
      expect(record(sse.snapshot(), 'close')?.backpressureCloses).toEqual(0);
      sse.observe('close', false, true);
      const close = record(sse.snapshot(), 'close')!;
      expect(close.backpressureCloses).toEqual(1);
      expect(close.failed).toEqual(2);
      // Only an sse CLOSE carries the number; its send record is null.
      sse.observe('send', false, true);
      expect(record(sse.snapshot(), 'send')?.backpressureCloses).toBeNull();
      // A succeeded close never counts as backpressure, even if flagged.
      sse.observe('close', true, true);
      expect(record(sse.snapshot(), 'close')?.backpressureCloses).toEqual(1);
    });

    it('ignores the backplane operations', async () => {
      const ws = collector('websocket');
      ws.observe('backplane-receive', true);
      expect(await ws.observePublish(() => Promise.resolve(1))).toEqual(1);
      expect(ws.snapshot().records).toEqual([]);
    });

    it('keeps the gauges current and the state ready after every record expired', () => {
      const clock = fakeClock();
      const gauges = fakeGauges(1, 0);
      const sse = collector('sse', { clock: clock.read, gauges: gauges.read });
      sse.observe('open', true);
      clock.now += REALTIME_COLLECTOR_LIMITS.retentionMs + 1;
      gauges.reading.groups = 2;
      const snapshot = sse.snapshot();
      expect(snapshot.state).toEqual('ready');
      expect(snapshot.records).toEqual([]);
      expect(snapshot.gauges).toEqual({ state: 'available', openConnections: 1, groups: 2 });
    });

    it('latches collection-failed when the gauge reader throws, and never calls it again', () => {
      let calls = 0;
      const ws = collector('websocket', {
        gauges: () => {
          calls++;
          throw new Error('SECRET-gauge');
        },
      });
      ws.observe('open', true);
      const failed = ws.snapshot();
      expect(failed).toEqual({
        state: 'collection-failed',
        alias: 'rt',
        sourceKind: 'websocket',
        coverage: 'owned-instance',
        gauges: { state: 'collection-failed', openConnections: null, groups: null },
        records: [],
        dropped: 0,
      });
      expect(JSON.stringify(failed)).not.toContain('SECRET');
      expect(ws.enabled).toBe(false);
      ws.observe('open', true);
      expect(ws.snapshot().state).toEqual('collection-failed');
      expect(calls).toEqual(1);
    });

    it('latches collection-failed for a gauge value outside the non-negative safe integers', () => {
      const bad: RealtimeGaugeReading[] = [
        { openConnections: -1, groups: 0 },
        { openConnections: 0, groups: 1.5 },
        { openConnections: Number.NaN, groups: 0 },
        { openConnections: 2 ** 53, groups: 0 },
        { openConnections: '1' as unknown as number, groups: 0 },
      ];
      for (const reading of bad) {
        const sse = collector('sse', { gauges: () => reading });
        expect(sse.snapshot().state).toEqual('collection-failed');
      }
    });
  });

  describe('backplane', () => {
    it('answers no-data with unsupported gauges before any operation', () => {
      expect(collector('backplane').snapshot()).toEqual({
        state: 'no-data',
        alias: 'rt',
        sourceKind: 'backplane',
        coverage: 'owned-instance',
        gauges: { state: 'unsupported', openConnections: null, groups: null },
        records: [],
        dropped: 0,
      });
    });

    it('times a publish, passing the value and the original rejection through', async () => {
      const clock = fakeClock();
      const backplane = collector('backplane', { clock: clock.read });
      const value = await backplane.observePublish(() => {
        clock.now += 12.7;
        return Promise.resolve('sent');
      });
      expect(value).toEqual('sent');
      const reason = new Error('SECRET-transport');
      const rejected = backplane.observePublish(() => {
        clock.now += 3;
        return Promise.reject(reason);
      });
      await expect(rejected).rejects.toBe(reason);
      const publish = record(backplane.snapshot(), 'backplane-publish')!;
      expect(publish).toEqual({
        alias: 'rt',
        operation: 'backplane-publish',
        count: 2,
        lastDurationMs: 3,
        ageMs: 0,
        succeeded: 1,
        failed: 1,
        backpressureCloses: null,
      });
    });

    it('records a synchronous publish throw as failed and rethrows it unchanged', () => {
      const backplane = collector('backplane');
      const reason = new Error('sync');
      expect(() =>
        backplane.observePublish(() => {
          throw reason;
        })
      ).toThrow(reason);
      expect(record(backplane.snapshot(), 'backplane-publish')?.failed).toEqual(1);
    });

    it('keeps an unobserved rejection unhandled (a derived promise, not a side branch)', async () => {
      const backplane = collector('backplane');
      const reason = new Error('unhandled');
      const unhandled: unknown[] = [];
      const listener = (event: PromiseRejectionEvent): void => {
        unhandled.push(event.reason);
        event.preventDefault();
      };
      globalThis.addEventListener('unhandledrejection', listener);
      try {
        void backplane.observePublish(() => Promise.reject(reason));
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        globalThis.removeEventListener('unhandledrejection', listener);
      }
      expect(unhandled).toEqual([reason]);
    });

    it('counts receives, ignores websocket operations, and goes stale then expires', () => {
      const clock = fakeClock();
      const backplane = collector('backplane', { clock: clock.read });
      backplane.observe('backplane-receive', true);
      backplane.observe('backplane-receive', false);
      backplane.observe('open', true);
      expect(backplane.snapshot().state).toEqual('ready');
      expect(backplane.snapshot().records.map((entry) => entry.operation)).toEqual([
        'backplane-receive',
      ]);
      expect(record(backplane.snapshot(), 'backplane-receive')?.lastDurationMs).toBeNull();
      clock.now += REALTIME_COLLECTOR_LIMITS.staleMs;
      expect(backplane.snapshot().state).toEqual('ready');
      clock.now += 1;
      expect(backplane.snapshot().state).toEqual('stale');
      clock.now += REALTIME_COLLECTOR_LIMITS.retentionMs;
      expect(backplane.snapshot().state).toEqual('no-data');
    });

    it('never reads a gauge reader even when one is supplied', () => {
      const gauges = fakeGauges(9, 9);
      collector('backplane', { gauges: gauges.read }).snapshot();
      expect(gauges.calls).toEqual(0);
    });
  });

  describe('retention', () => {
    it('restarts an expired record from zero on its next observation', () => {
      const clock = fakeClock();
      const ws = collector('websocket', { clock: clock.read });
      ws.observe('send', true);
      ws.observe('send', true);
      clock.now += REALTIME_COLLECTOR_LIMITS.retentionMs + 1;
      ws.observe('send', false);
      expect(record(ws.snapshot(), 'send')).toMatchObject({ count: 1, succeeded: 0, failed: 1 });
    });

    it('keeps a record observed exactly at the retention edge', () => {
      const clock = fakeClock();
      const ws = collector('websocket', { clock: clock.read });
      ws.observe('send', true);
      clock.now += REALTIME_COLLECTOR_LIMITS.retentionMs;
      ws.observe('send', true);
      expect(record(ws.snapshot(), 'send')?.count).toEqual(2);
    });

    it('never moves the activity reading backwards on an earlier clock value', () => {
      const clock = fakeClock(10_000);
      const ws = collector('websocket', { clock: clock.read });
      ws.observe('send', true);
      clock.now = 9_000;
      ws.observe('send', true);
      clock.now = 10_005;
      expect(record(ws.snapshot(), 'send')?.ageMs).toEqual(5);
    });
  });

  describe('clock failures', () => {
    it('latches on a throwing clock during an observation and stops capture', () => {
      let fail = false;
      const gauges = fakeGauges();
      const ws = collector('websocket', {
        clock: () => {
          if (fail) {
            throw new Error('SECRET-clock');
          }
          return 1;
        },
        gauges: gauges.read,
      });
      ws.observe('open', true);
      fail = true;
      ws.observe('open', true);
      fail = false;
      ws.observe('open', true);
      const snapshot = ws.snapshot();
      expect(snapshot.state).toEqual('collection-failed');
      expect(snapshot.alias).toEqual('rt');
      expect(snapshot.sourceKind).toEqual('websocket');
      expect(snapshot.records).toEqual([]);
      expect(gauges.calls).toEqual(0);
    });

    it('latches on a clock that returns a non-finite value, including during a read', () => {
      let value = 1;
      const sse = collector('sse', { clock: () => value });
      value = Number.NaN;
      expect(sse.snapshot().state).toEqual('collection-failed');
      value = 1;
      const bp = collector('backplane', { clock: () => value });
      value = Number.POSITIVE_INFINITY;
      bp.observe('backplane-receive', true);
      expect(bp.snapshot().state).toEqual('collection-failed');
    });

    it('a publish whose start reading failed still runs and passes its value through', async () => {
      let fail = true;
      const bp = collector('backplane', {
        clock: () => {
          if (fail) {
            throw new Error('x');
          }
          return 1;
        },
      });
      expect(await bp.observePublish(() => Promise.resolve('ok'))).toEqual('ok');
      fail = false;
      expect(bp.snapshot().state).toEqual('collection-failed');
    });

    it('a publish whose settlement reading failed latches and still passes its value through', async () => {
      let reads = 0;
      const bp = collector('backplane', {
        clock: () => {
          reads++;
          if (reads === 2) {
            throw new Error('x');
          }
          return reads;
        },
      });
      expect(await bp.observePublish(() => Promise.resolve('ok'))).toEqual('ok');
      expect(bp.snapshot().state).toEqual('collection-failed');
    });
  });

  describe('close', () => {
    it('answers disabled with unread gauges, discards late observations, and releases the reader', async () => {
      const gauges = fakeGauges(2, 3);
      const ws = collector('websocket', { gauges: gauges.read });
      ws.observe('open', true);
      let settle: (value: string) => void = () => {};
      const late = collector('backplane');
      const pending = late.observePublish(() =>
        new Promise<string>((resolve) => {
          settle = resolve;
        })
      );
      ws.close();
      ws.close();
      late.close();
      settle('done');
      expect(await pending).toEqual('done');
      ws.observe('open', true);
      for (const closed of [ws.snapshot(), late.snapshot()]) {
        expect(closed.state).toEqual('disabled');
        expect(closed.alias).toBeNull();
        expect(closed.records).toEqual([]);
        expect(closed.gauges).toEqual({ state: 'disabled', openConnections: null, groups: null });
      }
      expect(ws.snapshot().sourceKind).toEqual('websocket');
      expect(late.snapshot().sourceKind).toEqual('backplane');
      expect(gauges.calls).toEqual(0);
      expect(ws.enabled).toBe(false);
    });

    it('closed takes precedence over collection-failed', () => {
      const ws = collector('websocket', {
        gauges: () => {
          throw new Error('x');
        },
      });
      expect(ws.snapshot().state).toEqual('collection-failed');
      ws.close();
      expect(ws.snapshot().state).toEqual('disabled');
    });
  });

  it('clamps negative publish durations to 0', async () => {
    const values = [100, 90];
    const bp = collector('backplane', { clock: () => values.shift() ?? 90 });
    await bp.observePublish(() => Promise.resolve(0));
    expect(record(bp.snapshot(), 'backplane-publish')?.lastDurationMs).toEqual(0);
  });

  it('saturates every counter at Number.MAX_SAFE_INTEGER', () => {
    expect(bump(0)).toEqual(1);
    expect(bump(Number.MAX_SAFE_INTEGER - 1)).toEqual(Number.MAX_SAFE_INTEGER);
    expect(bump(Number.MAX_SAFE_INTEGER)).toEqual(Number.MAX_SAFE_INTEGER);
  });
});
