/**
 * The lap-based, keyset-paged relay (M107 §3.6), over the REAL memory-backed
 * bridge: separate scan and publish budgets, a cursor that advances one
 * examined row at a time, failed keys read only at lap start, a release
 * mid-lap that changes nothing until the next lap, cap-skips that block their
 * key, the 10 000-key blocked-set cap, no backoff overtaking, and a lap that
 * wraps to re-read a row committed behind the cursor.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey } from '@setu-ts/common';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';

import type { OutboxCommonOptions } from '../../../src/interfaces/index.ts';
import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { blockKey } from '../../../src/outbox/position.ts';
import type { LapHolder } from '../../../src/outbox/relay.ts';
import { SweepBudget, sweepStore } from '../../../src/outbox/relay.ts';
import {
  countingObserver,
  edit,
  ENTITY,
  outboxClock,
  type OutboxHarness,
  outboxHarness,
  WALL_START,
} from '../../fixtures/outbox.ts';

/** Writes `n` events of one key (or unkeyed), returning their ids. */
async function writeMany(
  h: OutboxHarness,
  key: string | undefined,
  from: number,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let n = from; n < from + count; n++) {
    ids.push(await h.write(key === undefined ? { n } : { key, n }));
  }
  return ids;
}

/** Runs one relay pass of the single store directly, exposing its lap. */
function directSweep(h: OutboxHarness, options: OutboxCommonOptions, holder: LapHolder) {
  const resolved = resolveOutboxOptions({ ...options, store: h.store });
  return sweepStore(
    {
      runtime: h.clock.runtime,
      broker: h.broker,
      telemetry: undefined,
      options: resolved,
      instanceId: 'direct',
      origin: 'scheduled',
      isClosing: () => false,
      observer: countingObserver(),
      budget: new SweepBudget(h.clock.runtime, resolved.sweepDeadlineMs),
    },
    h.store,
    holder,
  );
}

describe('relay paging', () => {
  it('a poisoned key with pageSize × 3 rows ahead does not starve a later key (scan covers them)', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 2, scanLimit: 100 } } });
    const [poison] = await writeMany(h, 'P', 0, 1);
    await writeMany(h, 'P', 1, 6);
    await writeMany(h, 'U', 100, 1);
    await edit(h.db, poison!, { status: 'failed' });
    const result = await h.sweep();
    expect(h.broker.sequence()).toEqual([100]);
    expect(result.endedBy).toBe('complete');
  });

  it('reaches the unblocked key within ceil(rowsAhead / scanLimit) + 1 sweeps when scan does not cover them', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 2, scanLimit: 3 } } });
    const [poison] = await writeMany(h, 'P', 0, 1);
    await writeMany(h, 'P', 1, 6);
    await writeMany(h, 'U', 100, 1);
    await edit(h.db, poison!, { status: 'failed' });
    const bound = Math.ceil(6 / 3) + 1;
    const ends: string[] = [];
    for (let sweep = 0; sweep < bound && h.broker.sequence().length === 0; sweep++) {
      ends.push((await h.sweep()).endedBy);
    }
    expect(h.broker.sequence()).toEqual([100]);
    expect(ends.slice(0, -1).every((end) => end === 'scan-limit')).toBe(true);
    // The lap seeded its blocked set once, at its start.
    expect(h.store.count('failedKeys')).toBe(1);
  });

  it('publishLimit stops mid-page; the cursor is the last EXAMINED row and nothing is skipped', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 10, publishLimit: 2 } } });
    await writeMany(h, undefined, 1, 5);
    expect((await h.sweep()).endedBy).toBe('publish-limit');
    expect(h.broker.sequence()).toEqual([1, 2]);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2, 3, 4]);
    // The second sweep resumed after row 2, not after the page's last row.
    const pages = h.store.calls.filter((c) => c.method === 'scanPending');
    const second = h.broker.published[1]!.message.id as string;
    expect(pages[1]!.args[0]).toBe(`00${WALL_START + 1}${second.replaceAll('-', '')}`);
    expect((await h.sweep()).endedBy).toBe('complete');
    expect(h.broker.sequence()).toEqual([1, 2, 3, 4, 5]);
  });

  it('a release mid-lap keeps the key blocked until the next lap, which publishes in position order', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 1, scanLimit: 1 } } });
    const [first] = await writeMany(h, 'K', 1, 3);
    await edit(h.db, first!, { status: 'failed' });
    await h.sweep(); // lap starts: K is seeded blocked; row 2 examined and skipped
    await h.service.release(first!, 'retry');
    await h.sweep(); // resumes: row 3 — K is still blocked in THIS lap
    expect(h.broker.sequence()).toEqual([]);
    // Re-seeding failedKeys mid-lap (the N1 reorder) would have published row 3
    // here, before row 1. The lap read failed keys exactly once.
    expect(h.store.count('failedKeys')).toBe(1);
    await h.sweep(); // an empty page ends the lap
    expect(h.broker.sequence()).toEqual([]);
    for (let n = 0; n < 3; n++) await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2, 3]);
    expect(h.store.count('failedKeys')).toBe(2);
  });

  it('a cap-skip blocks its key, and the cap holds for the rest of the lap', async () => {
    const h = await outboxHarness();
    const [failed] = await writeMany(h, 'F', 0, 1);
    await edit(h.db, failed!, { status: 'failed' });
    await writeMany(h, 'A', 1, 1);
    await writeMany(h, undefined, 2, 1);
    await writeMany(h, 'A', 3, 1);
    const holder: LapHolder = { lap: undefined };
    const options = { relay: { maxFailedScan: 1, scanLimit: 2 } };
    expect(await directSweep(h, options, holder)).toBe('scan-limit');
    expect(holder.lap!.capReached).toBe(true);
    expect(holder.lap!.isBlocked(blockKey(undefined, 'A'))).toBe(true);
    expect(h.broker.sequence()).toEqual([2]); // the unkeyed row still publishes
    expect(await directSweep(h, options, holder)).toBe('lap-complete');
    expect(h.broker.sequence()).toEqual([2]); // the later A row stays skipped
  });

  it('the 10 000-key blocked set: overflow sets capReached and publishes no keyed row', async () => {
    const h = await outboxHarness({ options: { relay: { maxFailedScan: 20_000 } } });
    const repo = h.db.getRepository<Record<string, unknown>, EntityKey>(ENTITY);
    for (let n = 0; n < 10_001; n++) {
      await repo.create({
        id: `failed-${n}`,
        kind: OUTBOX_RECORD_KIND,
        topic: 'orders.placed.v1',
        envelope: '{}',
        options: '{}',
        orderingKey: `key-${n}`,
        tenantId: null,
        traceparent: null,
        position: `000000000000001${String(n).padStart(32, '0')}`,
        createdAt: 1,
        status: 'failed',
        attempts: 10,
        availableAt: 1,
        lastError: 'x',
        settledAt: null,
        sentBy: null,
      });
    }
    await writeMany(h, 'fresh', 1, 1);
    await writeMany(h, undefined, 2, 1);
    const result = await h.sweep();
    expect(result.endedBy).toBe('complete');
    expect(h.broker.sequence()).toEqual([2]);
    // The lap ended (short page), so its overflow is no longer current.
    expect(h.service.instanceSignals().blockedKeyCap).toBe(false);
  });

  it('reports blockedKeyCap while the overflowing lap is in progress', async () => {
    const h = await outboxHarness({
      options: { relay: { maxFailedScan: 20_000, scanLimit: 1, pageSize: 1 } },
    });
    const repo = h.db.getRepository<Record<string, unknown>, EntityKey>(ENTITY);
    for (let n = 0; n < 10_001; n++) {
      await repo.create({
        id: `failed-${n}`,
        kind: OUTBOX_RECORD_KIND,
        status: 'failed',
        orderingKey: `key-${n}`,
        tenantId: null,
        position: `0${n}`,
      });
    }
    await writeMany(h, 'fresh', 1, 2);
    await h.sweep();
    expect(h.service.instanceSignals().blockedKeyCap).toBe(true);
  });

  it('a row in backoff is never overtaken by a later row of its key', async () => {
    const h = await outboxHarness();
    let failNext = true;
    h.broker.behaviour = () => {
      if (!failNext) return undefined;
      failNext = false;
      return Promise.reject(new Error('broker down'));
    };
    await writeMany(h, 'K', 1, 2);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([]);
    await h.sweep(); // row 1 still in backoff: it blocks K, row 2 waits
    expect(h.broker.sequence()).toEqual([]);
    h.clock.advanceWall(1000);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2]);
  });

  it('the lap wraps and re-reads a row committed behind the cursor', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 1, scanLimit: 1 } } });
    await writeMany(h, undefined, 1, 2);
    await h.sweep(); // examines row 1
    // Another writer whose clock is behind commits a row BELOW the cursor.
    const late = await outboxHarness({
      shared: { db: h.db, store: h.store },
      clock: outboxClock(0x100000),
    });
    late.clock.setWall(WALL_START - 5000);
    await late.write({ n: 0 });
    for (let n = 0; n < 4; n++) await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2, 0]);
  });
});
