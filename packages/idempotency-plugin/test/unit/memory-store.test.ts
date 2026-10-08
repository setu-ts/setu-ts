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

  it('clears on disconnect', async () => {
    const store = new MemoryIdempotencyStore();
    await store.connect(createClockRuntime());
    await store.claim(request());
    await store.disconnect();
    expect((await store.claim(request())).outcome).toBe('claimed');
  });
});
