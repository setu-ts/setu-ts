/**
 * Unit tests for the in-process store (plan §3.16), driving the shared
 * conformance fixture plus the memory-specific capacity behaviour.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IdempotencyClaimRequest, IIdempotencyStore } from '@setu-ts/common';
import { MemoryIdempotencyStore } from '../../src/stores/memory-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';
import type { ClockRuntime } from '../fixtures/clock-runtime.ts';
import { runIdempotencyStoreConformance } from '../fixtures/idempotency-store-conformance.ts';

const hex = (char: string): string => char.repeat(64);

/** A claim request with defaults. */
function request(over: Partial<IdempotencyClaimRequest> = {}): IdempotencyClaimRequest {
  return {
    key: hex('a'),
    scope: hex('b'),
    fingerprint: hex('c'),
    token: 'token-1',
    leaseMs: 100,
    ttlMs: 1_000,
    ...over,
  };
}

const runtime: ClockRuntime = createClockRuntime();

runIdempotencyStoreConformance('memory', {
  make: async () => {
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 1, maxEntries: 2 });
    await store.connect(runtime);
    return store;
  },
  advance: (ms) => {
    runtime.advance(ms);
    return Promise.resolve();
  },
  runtime,
});

describe('MemoryIdempotencyStore specifics (M109a §3.16)', () => {
  it('reports the store kind', async () => {
    const store: IIdempotencyStore = new MemoryIdempotencyStore();
    await store.connect(createClockRuntime());
    expect(store.name).toBe('memory');
    expect(store.maxRecordBytes).toBeUndefined();
  });

  it('throttles the capacity sweep to once per 1,000 ms', async () => {
    const clock = createClockRuntime();
    const store = new MemoryIdempotencyStore({ maxEntries: 1, maxEntriesPerScope: 10 });
    await store.connect(clock);
    await store.claim(request({ key: hex('1'), scope: hex('s'), ttlMs: 100 }));
    // Fills the cap; the sweep runs but nothing has expired.
    await expect(store.claim(request({ key: hex('2'), scope: hex('s'), ttlMs: 100 }))).rejects
      .toThrow(
        'memory idempotency store is full',
      );
    clock.advance(150);
    // The entry has expired, but the sweep is throttled, so the store still
    // refuses rather than sweeping a second time inside the window.
    await expect(store.claim(request({ key: hex('3'), scope: hex('s'), ttlMs: 100 }))).rejects
      .toThrow(
        'memory idempotency store is full',
      );
    clock.advance(1_000);
    expect((await store.claim(request({ key: hex('4'), scope: hex('s'), ttlMs: 100 }))).outcome)
      .toBe('claimed');
  });

  it('lazily expires an entry and releases its per-scope count', async () => {
    const clock = createClockRuntime();
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 1, maxEntries: 10 });
    await store.connect(clock);
    await store.claim(request({ key: hex('1'), scope: hex('s'), ttlMs: 100 }));
    clock.advance(150);
    // Same scope: the stale count is swept for that scope, so a new key fits.
    expect((await store.claim(request({ key: hex('2'), scope: hex('s'), ttlMs: 100 }))).outcome)
      .toBe('claimed');
  });

  it('throttles the per-scope sweep, so a refused at-cap claim does not rescan', async () => {
    const clock = createClockRuntime();
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 2, maxEntries: 10 });
    await store.connect(clock);
    await store.claim(request({ key: hex('1'), scope: 's1', ttlMs: 100 }));
    await store.claim(request({ key: hex('2'), scope: 's1', ttlMs: 60_000 }));
    clock.advance(150);
    // The first at-cap claim sweeps s1 and frees the expired key 1; key 2 is
    // live, so s1 keeps its keys AND its sweep row (t=150).
    expect((await store.claim(request({ key: hex('3'), scope: 's1', ttlMs: 100 }))).outcome)
      .toBe('claimed');
    // s1 is at its cap again with an expired key 3, but its sweep ran 150 ms
    // ago: the throttle refuses rather than rescanning.
    clock.advance(150);
    expect((await store.claim(request({ key: hex('4'), scope: 's1', ttlMs: 100 }))).outcome)
      .toBe('capacity-exceeded');
    // Another scope has its OWN window, so s1 does not hold it back.
    expect((await store.claim(request({ key: hex('5'), scope: 's2', ttlMs: 100 }))).outcome)
      .toBe('claimed');
    // Past the window, s1 sweeps again and the expired key is reclaimed.
    clock.advance(1_000);
    expect((await store.claim(request({ key: hex('6'), scope: 's1', ttlMs: 100 }))).outcome)
      .toBe('claimed');
  });

  it("drops a scope and its sweep row with the scope's last entry (M109a audit)", async () => {
    // Before the fix, a throttle row outlived its scope, so a caller cycling
    // identities grew the map by one row per scope that ever reached its cap.
    const clock = createClockRuntime();
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 1, maxEntries: 1_000 });
    await store.connect(clock);
    for (let n = 0; n < 50; n++) {
      await store.claim(request({ key: hex(`a${n}`), scope: `s${n}`, ttlMs: 100 }));
      // At its cap: this claim sweeps the scope, creating its throttle row.
      await store.claim(request({ key: hex(`b${n}`), scope: `s${n}`, ttlMs: 100 }));
    }
    expect(store.trackedScopeCounts()).toMatchObject({ scopes: 50, sweepRows: 50 });
    // Past both the keys' TTL and the throttle window.
    clock.advance(1_100);
    // Each scope's next at-cap claim sweeps out its expired key, emptying the
    // scope, so the row goes with it; the new key then starts the scope again.
    for (let n = 0; n < 50; n++) {
      await store.claim(request({ key: hex(`c${n}`), scope: `s${n}`, ttlMs: 100 }));
    }
    expect(store.trackedScopeCounts()).toMatchObject({ scopes: 50, sweepRows: 0 });
  });

  it('sweeps only the scope at its cap, not the whole store (M109a audit F2)', async () => {
    // A sweep used to scan every entry, so each scope at its cap cost a full
    // scan per window; with 100k entries that blocked the event loop for
    // seconds. It must visit only that scope's own keys.
    const clock = createClockRuntime();
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 2, maxEntries: 10_000 });
    await store.connect(clock);
    for (let n = 0; n < 5_000; n++) {
      await store.claim(request({ key: `other-${n}`, scope: 'other', ttlMs: 60_000 }));
    }
    await store.claim(request({ key: hex('1'), scope: 'target', ttlMs: 100 }));
    await store.claim(request({ key: hex('2'), scope: 'target', ttlMs: 60_000 }));
    clock.advance(150);
    expect((await store.claim(request({ key: hex('3'), scope: 'target' }))).outcome)
      .toBe('claimed');
    expect(store.trackedScopeCounts().lastSweepVisits).toBe(2);
  });

  it('clears every map on disconnect (M109a audit round 3, I2)', async () => {
    const store = new MemoryIdempotencyStore({ maxEntriesPerScope: 1 });
    await store.connect(createClockRuntime());
    await store.claim(request());
    // At its cap: this claim sweeps the scope, creating its throttle row.
    await store.claim(request({ key: hex('z') }));
    expect(store.trackedScopeCounts()).toMatchObject({ scopes: 1, sweepRows: 1, keyScopes: 1 });
    await store.disconnect();
    expect(store.trackedScopeCounts()).toMatchObject({ scopes: 0, sweepRows: 0, keyScopes: 0 });
    expect((await store.claim(request())).outcome).toBe('claimed');
  });
});
