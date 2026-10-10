/**
 * Outbox option resolution (M107 §4.1): defaults, every numeric option refused
 * by name at `NaN`, a fraction and out of range, the per-call bounds refused
 * when they exceed the sweep deadline, and the `store`/`stores` union.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IOutboxStore } from '@setu-ts/common';

import type { OutboxOptions } from '../../../src/interfaces/index.ts';
import {
  OutboxEnvelopeTooLargeError,
  OutboxNotReadyError,
  OutboxRelayUnscheduledError,
  OutboxRowStateError,
  OutboxUnknownTenantError,
} from '../../../src/outbox/errors.ts';
import { resolveOutboxOptions } from '../../../src/outbox/options.ts';

const store = {} as IOutboxStore;

describe('resolveOutboxOptions', () => {
  it('applies every default', () => {
    const resolved = resolveOutboxOptions({ store });
    expect(resolved).toEqual({
      maxEnvelopeBytes: 262_144,
      background: undefined,
      schedule: true,
      intervalMs: 1000,
      pageSize: 100,
      scanLimit: 1000,
      publishLimit: 100,
      maxFailedScan: 1000,
      maxAttempts: 10,
      baseBackoffMs: 1000,
      maxBackoffMs: 300_000,
      sweepDeadlineMs: 30_000,
      publishTimeoutMs: 5000,
      storeTimeoutMs: 5000,
      claimLeaseMs: 30000,
      maxClockSkewMs: 5000,
      degradedAfterMs: 60_000,
      overlapWindowMs: 600_000,
      retainSentMs: 604_800_000,
      purgeBatch: 100,
      purgeIntervalMs: 60_000,
      stores: { kind: 'single', entry: store },
    });
  });

  it('keeps supplied values', () => {
    const background = () => {};
    const resolved = resolveOutboxOptions({
      store,
      background,
      retainSentMs: 0,
      relay: { schedule: false, pageSize: 7, sweepDeadlineMs: 30_000 },
      health: { degradedAfterMs: 5 },
    });
    expect(resolved.background).toBe(background);
    expect(resolved.retainSentMs).toBe(0);
    expect(resolved.schedule).toBe(false);
    expect(resolved.pageSize).toBe(7);
    expect(resolved.sweepDeadlineMs).toBe(30_000);
    expect(resolved.degradedAfterMs).toBe(5);
  });

  const numeric: [string, (v: number) => Partial<OutboxOptions>][] = [
    ['relay.claimLeaseMs', (v) => ({ relay: { claimLeaseMs: v } })],
    ['relay.maxClockSkewMs', (v) => ({ relay: { maxClockSkewMs: v } })],
    ['maxEnvelopeBytes', (v) => ({ maxEnvelopeBytes: v })],
    ['relay.intervalMs', (v) => ({ relay: { intervalMs: v } })],
    ['relay.pageSize', (v) => ({ relay: { pageSize: v } })],
    ['relay.scanLimit', (v) => ({ relay: { scanLimit: v } })],
    ['relay.publishLimit', (v) => ({ relay: { publishLimit: v } })],
    ['relay.maxFailedScan', (v) => ({ relay: { maxFailedScan: v } })],
    ['relay.maxAttempts', (v) => ({ relay: { maxAttempts: v } })],
    ['relay.baseBackoffMs', (v) => ({ relay: { baseBackoffMs: v } })],
    ['relay.maxBackoffMs', (v) => ({ relay: { maxBackoffMs: v } })],
    ['relay.sweepDeadlineMs', (v) => ({ relay: { sweepDeadlineMs: v } })],
    ['relay.publishTimeoutMs', (v) => ({ relay: { publishTimeoutMs: v } })],
    ['relay.storeTimeoutMs', (v) => ({ relay: { storeTimeoutMs: v } })],
    ['health.degradedAfterMs', (v) => ({ health: { degradedAfterMs: v } })],
    ['health.overlapWindowMs', (v) => ({ health: { overlapWindowMs: v } })],
    ['retainSentMs', (v) => ({ retainSentMs: v })],
    ['purgeBatch', (v) => ({ purgeBatch: v })],
    ['purgeIntervalMs', (v) => ({ purgeIntervalMs: v })],
  ];
  for (const [name, build] of numeric) {
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      it(`refuses ${name} = ${bad} by name`, () => {
        expect(() => resolveOutboxOptions({ store, ...build(bad) } as OutboxOptions)).toThrow(
          `outbox: ${name} must be an integer`,
        );
      });
    }
  }

  it('refuses a value above its range and a maxBackoffMs below baseBackoffMs', () => {
    expect(() => resolveOutboxOptions({ store, relay: { pageSize: 10_001 } })).toThrow(
      'relay.pageSize',
    );
    expect(() => resolveOutboxOptions({ store, relay: { baseBackoffMs: 500, maxBackoffMs: 499 } }))
      .toThrow('relay.maxBackoffMs');
  });

  it('refuses reserve equality and overflow naming all three options, and accepts headroom', () => {
    for (const sweepDeadlineMs of [14999, 15000]) {
      expect(() =>
        resolveOutboxOptions({
          store,
          relay: { sweepDeadlineMs, publishTimeoutMs: 5000, storeTimeoutMs: 5000 },
        })
      ).toThrow(
        'relay.publishTimeoutMs + 2 * relay.storeTimeoutMs must be less than relay.sweepDeadlineMs',
      );
    }
    expect(
      resolveOutboxOptions({
        store,
        relay: { sweepDeadlineMs: 15_001, publishTimeoutMs: 5000, storeTimeoutMs: 5000 },
      }).sweepDeadlineMs,
    ).toBe(15_001);
  });

  it('pins lease and clock-skew ranges and the construction relation on both sides', () => {
    for (const [claimLeaseMs, maxClockSkewMs] of [[3600001, 0], [30000, 60001], [0, 0]]) {
      expect(() => resolveOutboxOptions({ store, relay: { claimLeaseMs, maxClockSkewMs } }))
        .toThrow(RangeError);
    }
    expect(
      resolveOutboxOptions({
        store,
        relay: { claimLeaseMs: 3, maxClockSkewMs: 0, publishTimeoutMs: 1, storeTimeoutMs: 1 },
      }),
    ).toBeDefined();
    expect(() => resolveOutboxOptions({ store, relay: { claimLeaseMs: 19999 } }))
      .toThrow('relay.publishTimeoutMs + 2 * relay.storeTimeoutMs + relay.maxClockSkewMs');
    expect(resolveOutboxOptions({ store, relay: { claimLeaseMs: 20000 } }).claimLeaseMs).toBe(
      20000,
    );
    expect(
      resolveOutboxOptions({ store, relay: { claimLeaseMs: 3600000, maxClockSkewMs: 60000 } })
        .maxClockSkewMs,
    ).toBe(60000);
  });

  it('refuses a non-boolean schedule and a non-function background', () => {
    expect(() => resolveOutboxOptions({ store, relay: { schedule: 'yes' as unknown as boolean } }))
      .toThrow('relay.schedule');
    expect(() => resolveOutboxOptions({ store, background: 1 as unknown as () => void })).toThrow(
      'background',
    );
  });

  it('requires exactly one of store and stores', () => {
    // @ts-expect-error — supplying both is a compile error
    const both: OutboxOptions = { store, stores: { t: store } };
    expect(() => resolveOutboxOptions(both)).toThrow('exactly one of store and stores');
    expect(() => resolveOutboxOptions({} as OutboxOptions)).toThrow('exactly one');
    expect(() => resolveOutboxOptions({ store: 5 as unknown as IOutboxStore })).toThrow(
      'store must be',
    );
  });

  it('resolves per-tenant stores and refuses a malformed map', () => {
    const resolved = resolveOutboxOptions({ stores: { acme: store, globex: () => store } });
    expect(resolved.stores.kind).toBe('per-tenant');
    if (resolved.stores.kind === 'per-tenant') {
      expect([...resolved.stores.entries.keys()]).toEqual(['acme', 'globex']);
    }
    expect(() => resolveOutboxOptions({ stores: [] as unknown as Record<string, IOutboxStore> }))
      .toThrow('keyed by tenant id');
    expect(() => resolveOutboxOptions({ stores: {} })).toThrow('at least one tenant');
    expect(() => resolveOutboxOptions({ stores: { ' bad': store } })).toThrow('valid tenant id');
    expect(() => resolveOutboxOptions({ stores: { acme: 3 as unknown as IOutboxStore } }))
      .toThrow('each stores entry');
  });
});

describe('outbox errors', () => {
  it('carry their names and never quote row contents or tenant ids', () => {
    const tooLarge = new OutboxEnvelopeTooLargeError(300, 200);
    expect(tooLarge.name).toBe('OutboxEnvelopeTooLargeError');
    expect(tooLarge.message).toContain('300');
    expect(new OutboxRelayUnscheduledError().message).toContain('SchedulerPlugin');
    expect(new OutboxRelayUnscheduledError().name).toBe('OutboxRelayUnscheduledError');
    expect(new OutboxUnknownTenantError().name).toBe('OutboxUnknownTenantError');
    expect(new OutboxNotReadyError().name).toBe('OutboxNotReadyError');
    const missing = new OutboxRowStateError('missing');
    expect(missing.outcome).toBe('missing');
    expect('status' in missing).toBe(false);
    const notFailed = new OutboxRowStateError('not-failed', 'sent');
    expect(notFailed.status).toBe('sent');
    expect(notFailed.message).toContain('sent');
    expect(new OutboxRowStateError('not-failed').message).toContain('not failed');
  });
});
