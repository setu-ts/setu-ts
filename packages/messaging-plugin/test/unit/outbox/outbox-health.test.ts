/**
 * The `outbox` health indicator (M107 §3.11): lifecycle truth first; the
 * three cluster-wide reasons read from the STORE (oldest pending age, failed
 * rows, and `failed-scan-cap` derived from the failed count); the three
 * per-instance reasons from this instance's own relay; `down` when the store
 * does not answer; and `data` carrying counts, ages and fixed reasons only.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IOutboxStore } from '@setu-ts/common';

import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import type { OutboxCollector } from '../../../src/outbox/outbox-collector.ts';
import { createOutboxHealthIndicator } from '../../../src/outbox/outbox-health.ts';
import type { OutboxHealthSource } from '../../../src/outbox/outbox-health.ts';
import type { OutboxInstanceSignals } from '../../../src/outbox/outbox-service.ts';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import type { OutboxCommonOptions } from '../../../src/interfaces/index.ts';
import { edit, flush, outboxHarness } from '../../fixtures/outbox.ts';
import type { OutboxHarness } from '../../fixtures/outbox.ts';

/** Builds the indicator over a harness's real service. */
function indicatorFor(
  h: OutboxHarness,
  options: OutboxCommonOptions = {},
  source: OutboxHealthSource = h.service,
  collector?: OutboxCollector,
): () => Promise<HealthCheckResult> {
  return createOutboxHealthIndicator({
    runtime: h.clock.runtime,
    source,
    options: resolveOutboxOptions({ ...options, store: h.store }),
    ...(collector !== undefined ? { collector } : {}),
  }) as () => Promise<HealthCheckResult>;
}

/** A source over a harness's stores with chosen per-instance signals. */
function signalling(
  h: OutboxHarness,
  signals: OutboxInstanceSignals,
): OutboxHealthSource {
  return {
    activeStores: () => [h.store],
    closing: false,
    instanceSignals: () => signals,
  };
}

const QUIET: OutboxInstanceSignals = {
  blockedKeyCap: false,
  storeWriteFailing: false,
  scheduledOverlap: false,
};

describe('outbox health indicator', () => {
  it('reports down with ready: false before activation, and reads nothing', async () => {
    const h = await outboxHarness();
    const inactive = new OutboxService({
      runtime: h.clock.runtime,
      broker: h.broker,
      options: resolveOutboxOptions({ store: h.store }),
    });
    const result = await indicatorFor(h, {}, inactive)();
    expect(result).toEqual({ status: 'down', data: { ready: false } });
    expect(h.store.count('stats')).toBe(0);
  });

  it('reports down with ready: false once closing (lifecycle truth)', async () => {
    const h = await outboxHarness();
    await h.service.close();
    expect(await indicatorFor(h)()).toEqual({ status: 'down', data: { ready: false } });
  });

  it('reports up with counts when the store is healthy and its oldest row is young', async () => {
    // A replica that never sweeps reports none of the per-instance reasons.
    const h = await outboxHarness();
    await h.write({ n: 1 });
    h.clock.advanceWall(30_000);
    const result = await indicatorFor(h)();
    expect(result).toEqual({
      status: 'up',
      data: {
        ready: true,
        reachable: true,
        pending: 1,
        failed: 0,
        oldestPendingAgeMs: 30_000,
        reasons: [],
      },
    });
  });

  it('degrades on oldest-pending-age past degradedAfterMs, read from the store', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    h.clock.advanceWall(1_001);
    const result = await indicatorFor(h, { health: { degradedAfterMs: 1_000 } })();
    expect(result.status).toBe('degraded');
    expect(result.data?.reasons).toEqual(['oldest-pending-age']);
  });

  it('degrades on failed-rows, and adds failed-scan-cap when failed reaches maxFailedScan', async () => {
    const h = await outboxHarness();
    const a = await h.write({ key: 'A', n: 1 });
    const b = await h.write({ key: 'B', n: 2 });
    await edit(h.db, a, { status: 'failed' });
    const belowCap = await indicatorFor(h, { relay: { maxFailedScan: 2 } })();
    expect(belowCap.status).toBe('degraded');
    expect(belowCap.data?.reasons).toEqual(['failed-rows']);
    await edit(h.db, b, { status: 'failed' });
    // Exactly maxFailedScan failed rows: a lap's blocked set may be incomplete.
    const atCap = await indicatorFor(h, { relay: { maxFailedScan: 2 } })();
    expect(atCap.data?.reasons).toEqual(['failed-rows', 'failed-scan-cap']);
    expect(atCap.data?.failed).toBe(2);
  });

  it('reports each per-instance reason from the instance signals, with the last sweep', async () => {
    const h = await outboxHarness();
    const lastSweep = {
      origin: 'scheduled',
      scanned: 3,
      published: 1,
      failures: 1,
      poisoned: 0,
      endedBy: 'store-failure',
    } as const;
    const result = await indicatorFor(
      h,
      {},
      signalling(h, {
        blockedKeyCap: true,
        storeWriteFailing: true,
        scheduledOverlap: true,
        lastSweep,
      }),
    )();
    expect(result.status).toBe('degraded');
    expect(result.data?.reasons).toEqual([
      'blocked-key-cap',
      'store-write-failing',
      'scheduled-overlap',
    ]);
    expect(result.data?.lastSweep).toEqual(lastSweep);
  });

  it('derives store-write-failing from a real sweep that ended on a store failure', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    h.store.faults.markSent = () => {
      throw new Error('store down');
    };
    expect((await h.sweep()).endedBy).toBe('store-failure');
    const result = await indicatorFor(h)();
    expect(result.data?.reasons).toEqual(['store-write-failing']);
  });

  it('reports down with reachable: false when stats() rejects', async () => {
    const h = await outboxHarness();
    h.store.faults.stats = () => {
      throw new Error('store down');
    };
    expect(await indicatorFor(h)()).toEqual({
      status: 'down',
      data: { ready: true, reachable: false },
    });
  });

  it('reports down when stats() does not answer within its bound', async () => {
    const h = await outboxHarness();
    h.store.faults.stats = () => new Promise<void>(() => {});
    let result: HealthCheckResult | undefined;
    const pending = indicatorFor(h)().then((r) => (result = r));
    await flush();
    expect(result).toBeUndefined();
    await h.clock.advance(2_000);
    await pending;
    expect(result).toEqual({ status: 'down', data: { ready: true, reachable: false } });
  });

  it('caches the store read for 5 s', async () => {
    const h = await outboxHarness();
    const indicator = indicatorFor(h);
    await indicator();
    await indicator();
    expect(h.store.count('stats')).toBe(1);
    await h.clock.advance(5_000);
    await indicator();
    expect(h.store.count('stats')).toBe(2);
  });

  it('sums every store, and derives failed-scan-cap per store (laps are per store)', async () => {
    const h = await outboxHarness();
    const second = await outboxHarness({ clock: h.clock });
    const a = await h.write({ key: 'A', n: 1 });
    const b = await second.write({ key: 'B', n: 2 });
    await second.write({ n: 3 });
    await edit(h.db, a, { status: 'failed' });
    await edit(second.db, b, { status: 'failed' });
    const stores: IOutboxStore[] = [h.store, second.store];
    const indicator = (maxFailedScan: number) =>
      createOutboxHealthIndicator({
        runtime: h.clock.runtime,
        source: { activeStores: () => stores, closing: false, instanceSignals: () => QUIET },
        options: resolveOutboxOptions({ relay: { maxFailedScan }, store: h.store }),
      })();
    // Two failed rows in total, but one per store: no store's lap is capped.
    const perStore = await indicator(2);
    expect(perStore.data?.pending).toBe(1);
    expect(perStore.data?.failed).toBe(2);
    expect(perStore.data?.reasons).toEqual(['failed-rows']);
    expect((await indicator(1)).data?.reasons).toEqual(['failed-rows', 'failed-scan-cap']);
  });

  it('never carries a tenant id, an ordering key, a topic or error text in data', async () => {
    const h = await outboxHarness();
    const id = await h.write({ key: 'secret-key', n: 1 }, { tenantId: 'secret-tenant' });
    await edit(h.db, id, { status: 'failed', lastError: 'secret-error-text' });
    const text = JSON.stringify(await indicatorFor(h)());
    for (const leak of ['secret-key', 'secret-tenant', 'secret-error-text', 'orders.placed']) {
      expect(text.includes(leak)).toBe(false);
    }
  });

  it('feeds every fresh store read to the collector', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    h.clock.advanceWall(4_000);
    const synced: [number, number | undefined][] = [];
    const collector = {
      syncStats: (pending: number, age: number | undefined) => synced.push([pending, age]),
    } as unknown as OutboxCollector;
    const indicator = indicatorFor(h, {}, h.service, collector);
    await indicator();
    await indicator();
    expect(synced).toEqual([[1, 4_000]]);
  });
});
