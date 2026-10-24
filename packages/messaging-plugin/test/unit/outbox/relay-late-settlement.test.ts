/**
 * Late settlement of an invoked publish (V9-20): after a publish was actually
 * invoked, `markSent` and `markFailure` run under their own `storeTimeoutMs`
 * bound even when a pause has exhausted the sweep budget, and their answer
 * is observed — the overlap recorded, the late rejection swallowed — even
 * when it arrives after the call's bound. A `markFailure` for a publish the
 * budget refused to invoke is still never written. The pause is simulated by
 * advancing the paused relay's clocks, in the order a SIGSTOP produces:
 * `advance()` fires due timers, `step()` moves the monotonic clock without
 * firing any, and the wall clocks move past the claim lease so the other
 * relay can take the row.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import type { OutboxTransition } from '@setu-ts/common';

import type { OutboxSweepResult } from '../../../src/interfaces/index.ts';
import {
  countingObserver,
  edit,
  FaultStore,
  flush,
  memoryOutbox,
  outboxClock,
  outboxHarness,
  row,
  WALL_START,
  type OutboxHarness,
} from '../../fixtures/outbox.ts';
import type { OutboxRelayObserver } from '../../../src/outbox/relay.ts';

/** One deadline over the whole sweep, 100 ms per call. */
const RELAY = { sweepDeadlineMs: 1000, publishTimeoutMs: 100, storeTimeoutMs: 100 };

/** A fault that rejects once, then lets calls through. */
function rejectOnce(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    throw new Error('store down');
  };
}

/** A `FaultStore` whose `markSent` throws synchronously. */
class SyncThrowingStore extends FaultStore {
  override markSent(
    _id: string,
    _update: {
      readonly claimVersion: number;
      readonly settledAt: number;
      readonly sentBy: string;
      readonly deleteNow: boolean;
    },
  ): Promise<OutboxTransition> {
    throw new Error('synchronous markSent');
  }
}

/**
 * Two relays over one shared store, each with its own clock and broker,
 * ready for relay A to be paused while relay B settles the row.
 */
async function twoRelays(
  observer?: OutboxRelayObserver,
): Promise<{ a: OutboxHarness; b: OutboxHarness }> {
  const a = await outboxHarness({
    options: { relay: RELAY },
    ...(observer !== undefined ? { observer } : {}),
  });
  const b = await outboxHarness({
    options: { relay: RELAY },
    shared: { db: a.db, store: new FaultStore(a.store.inner) },
    clock: outboxClock(10_000),
  });
  return { a, b };
}

/** Moves both wall clocks past the claim lease plus the clock skew. */
function pastLease(a: OutboxHarness, b: OutboxHarness): void {
  a.clock.setWall(WALL_START + 35_000);
  b.clock.setWall(WALL_START + 35_000);
}

/** Records unhandled rejections so a missed handler fails the test. */
function watchRejections(): { readonly seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  return { seen, stop: () => process.off('unhandledRejection', onRejection) };
}

/**
 * Yields to the event loop once: every pending microtask chain — a whole
 * second relay over the bridge included — settles before the yield returns.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('late settlement of an invoked publish', () => {
  it('a pause between publish and markSent: the store is called despite the exhausted budget, and the answer reports a duplicate', async () => {
    const observer = countingObserver();
    const { a, b } = await twoRelays(observer);
    const id = await a.write({ n: 1 });
    // Pause A inside its publish: A's monotonic clock runs past the sweep
    // deadline (firing NO timers), the wall clocks move past the lease, and
    // B settles the row on the shared store before A's publish resolves.
    a.broker.behaviour = async () => {
      a.clock.step(1000);
      pastLease(a, b);
      await b.sweep();
    };
    const result = await a.sweep();
    // The settle ran under its own bound even with the budget exhausted: the
    // store WAS called, and the answer — in time here — was observed.
    expect(a.store.count('markSent')).toBe(1);
    expect(result.endedBy).toBe('complete');
    expect(b.broker.sequence()).toEqual([1]);
    expect(await row(a.db, id)).toMatchObject({ status: 'sent' });
    expect(observer.counts['overlap-duplicate']).toBe(1);
  });

  it('a pause inside markSent: the answer after the bound still reports a duplicate', async () => {
    const observer = countingObserver();
    const { a, b } = await twoRelays(observer);
    const id = await a.write({ n: 1 });
    // The fault hook runs AFTER the settle's deadline is armed: fire it,
    // move the wall clocks past the lease, let B settle the row, and the
    // delegate answers after its bound.
    a.store.faults.markSent = async () => {
      await a.clock.advance(100);
      pastLease(a, b);
      await b.sweep();
    };
    const watch = watchRejections();
    let result: OutboxSweepResult;
    try {
      result = await a.sweep();
      await settle();
    } finally {
      watch.stop();
    }
    expect(result.endedBy).toBe('store-failure');
    expect(a.service.instanceSignals().storeWriteFailing).toBe(true);
    expect(a.store.count('markSent')).toBe(1);
    expect(b.broker.sequence()).toEqual([1]);
    expect(await row(a.db, id)).toMatchObject({ status: 'sent' });
    expect(observer.counts['overlap-duplicate']).toBe(1);
    expect(watch.seen).toEqual([]);
  });

  it('a markSent whose run throws synchronously ends the sweep with a store failure', async () => {
    const base = await memoryOutbox();
    const h = await outboxHarness({
      options: { relay: RELAY },
      shared: { db: base.db, store: new SyncThrowingStore(base.store.inner) },
    });
    await h.write({ n: 1 });
    const watch = watchRejections();
    let result: OutboxSweepResult;
    try {
      result = await h.sweep();
      await settle();
    } finally {
      watch.stop();
    }
    expect(result.endedBy).toBe('store-failure');
    expect(watch.seen).toEqual([]);
  });

  it('the settle bound is exactly storeTimeoutMs with the budget exhausted', async () => {
    const { a, b } = await twoRelays();
    const id = await a.write({ n: 1 });
    let releaseHang: (() => void) | undefined;
    a.broker.behaviour = async () => {
      a.clock.step(1000); // A's budget is exhausted before the settle
      pastLease(a, b);
      await b.sweep();
    };
    a.store.faults.markSent = () => {
      a.clock.advance(99); // one ms short of the settle's own bound: no fire
      return new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
    };
    const sweep = a.sweep();
    await flush();
    expect(a.store.count('markSent')).toBe(1);
    // The settle armed exactly storeTimeoutMs despite budget.remaining() <= 0.
    expect(a.clock.timerCount()).toBe(1);
    await a.clock.advance(1); // the bound, exactly, fires the settle
    expect((await sweep).endedBy).toBe('store-failure');
    releaseHang!(); // now the delegate runs; the answer is late
    await flush();
    expect(await row(a.db, id)).toMatchObject({ status: 'sent' });
  });

  it('a budget exhausted before the publish: the broker and markFailure are never called, attempts unchanged', async () => {
    const observer = countingObserver();
    const h = await outboxHarness({ options: { relay: RELAY }, observer });
    const id = await h.write({ n: 1 });
    // The claim itself consumes the whole sweep budget; the publish is then
    // refused by the budget and never invoked.
    h.store.faults.claim = () => {
      h.clock.step(1000);
    };
    const result = await h.sweep();
    // A pause is the sweep's deadline, not a store or publish failure.
    expect(result.endedBy).toBe('deadline');
    expect(result.failures).toBe(0);
    expect(observer.counts['publishFailed']).toBeUndefined();
    expect(h.service.instanceSignals().storeWriteFailing).toBe(false);
    expect(h.broker.calls).toEqual([]);
    expect(h.store.count('markFailure')).toBe(0);
    expect(await row(h.db, id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a markFailure finding the row sent reports a duplicate, in time and late', async () => {
    // In time: A is paused inside its publish (B settles the row first), and
    // A's markFailure answers in time.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      await a.write({ n: 1 });
      a.broker.behaviour = async () => {
        pastLease(a, b);
        await b.sweep();
        await a.clock.advance(100); // the publish's own deadline fires
      };
      const result = await a.sweep();
      expect(result.failures).toBe(1);
      expect(a.broker.calls).toHaveLength(1); // the publish was invoked
      expect(a.store.count('markFailure')).toBe(1);
      expect(b.broker.sequence()).toEqual([1]);
      expect(observer.counts['overlap-duplicate']).toBe(1);
    }
    // Late: the same pause, plus the markFailure's own deadline firing before
    // its answer arrives.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      await a.write({ n: 1 });
      a.broker.behaviour = async () => {
        pastLease(a, b);
        await b.sweep();
        await a.clock.advance(100); // the publish's own deadline fires
      };
      a.store.faults.markFailure = async () => {
        await a.clock.advance(100); // the settle's own deadline fires
      };
      const watch = watchRejections();
      let result: OutboxSweepResult;
      try {
        result = await a.sweep();
        await settle();
      } finally {
        watch.stop();
      }
      expect(result.endedBy).toBe('store-failure');
      expect(a.store.count('markFailure')).toBe(1);
      expect(b.broker.sequence()).toEqual([1]);
      expect(observer.counts['overlap-duplicate']).toBe(1);
      expect(watch.seen).toEqual([]);
    }
  });

  it('a markFailure finding another claim reports claim-lost, in time and late', async () => {
    // In time: B claims only (its own markSent is rejected), so the row stays
    // pending under B's claim when A's markFailure answers in time.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      await a.write({ n: 1 });
      b.store.faults.markSent = rejectOnce();
      a.broker.behaviour = async () => {
        pastLease(a, b);
        await b.sweep();
        await a.clock.advance(100);
      };
      await a.sweep();
      expect(observer.counts['overlap-claim-lost']).toBe(1);
      expect(observer.counts['overlap-duplicate']).toBeUndefined();
    }
    // Late: the settle's own deadline fires before the answer arrives.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      await a.write({ n: 1 });
      b.store.faults.markSent = rejectOnce();
      a.broker.behaviour = async () => {
        pastLease(a, b);
        await b.sweep();
        await a.clock.advance(100);
      };
      a.store.faults.markFailure = async () => {
        await a.clock.advance(100);
      };
      const watch = watchRejections();
      let result: OutboxSweepResult;
      try {
        result = await a.sweep();
        await settle();
      } finally {
        watch.stop();
      }
      expect(result.endedBy).toBe('store-failure');
      expect(observer.counts['overlap-claim-lost']).toBe(1);
      expect(watch.seen).toEqual([]);
    }
  });

  it('a markSent finding another claim reports claim-lost, in time and late', async () => {
    // In time: the row's claim version is edited out from under A before its
    // markSent answers.
    {
      const observer = countingObserver();
      const h = await outboxHarness({ options: { relay: RELAY }, observer });
      const id = await h.write({ n: 1 });
      h.store.faults.markSent = async () => {
        await edit(h.db, id, { claimVersion: 7 });
      };
      await h.sweep();
      expect(observer.counts['overlap-claim-lost']).toBe(1);
    }
    // Late: B claims the row while A is paused inside its markSent.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      const id = await a.write({ n: 1 });
      b.store.faults.markSent = rejectOnce(); // B claims, then its settle is refused
      a.store.faults.markSent = async () => {
        await a.clock.advance(100);
        pastLease(a, b);
        await b.sweep();
      };
      const watch = watchRejections();
      let result: OutboxSweepResult;
      try {
        result = await a.sweep();
        await settle();
      } finally {
        watch.stop();
      }
      expect(result.endedBy).toBe('store-failure');
      expect(await row(a.db, id)).toMatchObject({ status: 'pending', claimVersion: 2 });
      expect(observer.counts['overlap-claim-lost']).toBe(1);
      expect(watch.seen).toEqual([]);
    }
  });

  it('a markSent finding the row failed records nothing and blocks the key, in time and late', async () => {
    // In time: the row is failed out from under A's in-time markSent; the
    // key is blocked, so the later row of the key is not published.
    {
      const observer = countingObserver();
      const h = await outboxHarness({ options: { relay: RELAY }, observer });
      const first = await h.write({ key: 'K', n: 1 });
      await h.write({ key: 'K', n: 2 });
      h.store.faults.markSent = async () => {
        await edit(h.db, first, { status: 'failed' });
      };
      await h.sweep();
      expect(h.broker.sequence()).toEqual([1]); // row 2 skipped: the key is blocked
      expect(observer.counts['overlap-duplicate']).toBeUndefined();
      expect(observer.counts['overlap-claim-lost']).toBeUndefined();
    }
    // Late: the same answer after the settle's own deadline.
    {
      const observer = countingObserver();
      const { a, b } = await twoRelays(observer);
      const first = await a.write({ key: 'K', n: 1 });
      await a.write({ key: 'K', n: 2 });
      b.store.faults.markSent = rejectOnce();
      a.store.faults.markSent = async () => {
        await a.clock.advance(100);
        pastLease(a, b);
        await b.sweep(); // B claims (its settle is refused)
        await edit(a.db, first, { status: 'failed' });
      };
      const watch = watchRejections();
      let result: OutboxSweepResult;
      try {
        result = await a.sweep();
        await flush();
      } finally {
        watch.stop();
      }
      expect(result.endedBy).toBe('store-failure');
      expect(a.broker.sequence()).toEqual([1]);
      expect(observer.counts['overlap-duplicate']).toBeUndefined();
      expect(observer.counts['overlap-claim-lost']).toBeUndefined();
      expect(watch.seen).toEqual([]);
    }
  });

  it('a late markFailure making the row failed records poisoned without touching the budget', async () => {
    const observer = countingObserver();
    const h = await outboxHarness({
      options: { relay: { ...RELAY, maxAttempts: 1 } },
      observer,
    });
    const id = await h.write({ n: 1 });
    h.broker.behaviour = async () => {
      await h.clock.advance(100); // the publish's own deadline fires
    };
    h.store.faults.markFailure = async () => {
      await h.clock.advance(100); // the settle's own deadline fires
    };
    const watch = watchRejections();
    let result: OutboxSweepResult;
    try {
      result = await h.sweep();
      await settle();
    } finally {
      watch.stop();
    }
    expect(result.endedBy).toBe('store-failure');
    expect(result.poisoned).toBe(0); // the budget is untouched after the sweep
    expect(observer.counts.poisoned).toBe(1); // but the row is observed failed
    expect(await row(h.db, id)).toMatchObject({ status: 'failed' });
    expect(watch.seen).toEqual([]);
  });

  it('an in-time markFailure making the row failed counts it against the budget', async () => {
    const observer = countingObserver();
    const h = await outboxHarness({
      options: { relay: { ...RELAY, maxAttempts: 1 } },
      observer,
    });
    const id = await h.write({ n: 1 });
    h.broker.behaviour = async () => {
      await h.clock.advance(100); // the publish's own deadline fires
    };
    const result = await h.sweep();
    expect(result.poisoned).toBe(1);
    expect(observer.counts.poisoned).toBe(1);
    expect(await row(h.db, id)).toMatchObject({ status: 'failed' });
  });

  it('an applied markFailure for a pending status, and a missing row, record nothing', async () => {
    // Applied with status `pending` (the default maxAttempts leaves it short
    // of `failed`): the write is a plain retry, nothing is recorded.
    {
      const observer = countingObserver();
      const h = await outboxHarness({ options: { relay: RELAY }, observer });
      await h.write({ n: 1 });
      let accept: (() => void) | undefined;
      h.broker.behaviour = () => new Promise<void>((resolve) => (accept = resolve));
      const sweep = h.sweep();
      await flush();
      await h.clock.advance(100); // the publish's own deadline fires
      accept!();
      await flush();
      expect((await sweep).failures).toBe(1);
      expect(observer.counts.poisoned).toBeUndefined();
      expect(observer.counts['overlap-duplicate']).toBeUndefined();
      expect(observer.counts['overlap-claim-lost']).toBeUndefined();
    }
    // Missing: the row is deleted out from under the markSent, in time and
    // late.
    for (const late of [false, true]) {
      const observer = countingObserver();
      const h = await outboxHarness({ options: { relay: RELAY }, observer });
      const id = await h.write({ n: 1 });
      h.store.faults.markSent = async () => {
        if (late) await h.clock.advance(100);
        await h.db.getRepository<Record<string, unknown>>('Outbox').delete(id);
      };
      const result = await h.sweep();
      await settle();
      expect(result.endedBy).toBe(late ? 'store-failure' : 'complete');
      expect(observer.counts['overlap-duplicate']).toBeUndefined();
      expect(observer.counts['overlap-claim-lost']).toBeUndefined();
      expect(observer.counts.poisoned).toBeUndefined();
    }
  });

  it('a late rejection is swallowed without an unhandled rejection', async () => {
    const { a } = await twoRelays();
    const id = await a.write({ n: 1 });
    a.store.faults.markSent = async () => {
      await a.clock.advance(100); // the settle's own deadline fires
      throw new Error('store down'); // the store then rejects
    };
    const watch = watchRejections();
    let result: OutboxSweepResult;
    try {
      result = await a.sweep();
      await settle();
    } finally {
      watch.stop();
    }
    expect(result.endedBy).toBe('store-failure');
    expect(a.store.count('markSent')).toBe(1);
    expect(await row(a.db, id)).toMatchObject({ status: 'pending' });
    expect(watch.seen).toEqual([]);
  });

  it('a late answer is dropped when the outbox is closing', async () => {
    const observer = countingObserver();
    const { a, b } = await twoRelays(observer);
    const id = await a.write({ n: 1 });
    let releaseHang: (() => void) | undefined;
    a.store.faults.markSent = async () => {
      // Fire the settle's deadline, let B settle the row (so the late answer
      // WOULD be a duplicate), then hold the store call open.
      await a.clock.advance(100);
      pastLease(a, b);
      await b.sweep();
      return new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
    };
    const result = await a.sweep(); // the settle's rejection ends the sweep
    await settle(); // the hook's b.sweep() settles the row; releaseHang is set
    expect(result.endedBy).toBe('store-failure');
    await a.service.close(); // the in-flight sweep has settled; close completes
    releaseHang!(); // the store call now answers — late, and the outbox is closing
    await flush();
    expect(await row(a.db, id)).toMatchObject({ status: 'sent' });
    expect(observer.counts['overlap-duplicate']).toBeUndefined();
  });

  it('a throwing observer on a late answer does not surface as an unhandled rejection', async () => {
    const { a, b } = await twoRelays();
    const throwing: OutboxRelayObserver = {
      published: (): void => {},
      publishFailed: (): void => {},
      poisoned: (): void => {},
      overlap: (): void => {
        throw new Error('observer down');
      },
    };
    const h = await outboxHarness({
      options: { relay: RELAY },
      shared: { db: a.db, store: new FaultStore(a.store.inner) },
      clock: outboxClock(20_000),
      observer: throwing,
    });
    await h.write({ n: 1 });
    h.store.faults.markSent = async () => {
      await h.clock.advance(100);
      pastLease(h, b);
      await b.sweep();
    };
    const watch = watchRejections();
    let result: OutboxSweepResult;
    try {
      result = await h.sweep();
      await settle();
    } finally {
      watch.stop();
    }
    expect(result.endedBy).toBe('store-failure');
    expect(watch.seen).toEqual([]);
  });
});
