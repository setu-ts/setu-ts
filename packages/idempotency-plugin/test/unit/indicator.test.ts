/**
 * Unit tests for the idempotency health indicator (plan §3.14).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIdempotencyStore } from '@setu-ts/common';
import { createIdempotencyIndicator } from '../../src/health/indicator.ts';
import type { IdempotencyLifecycleState } from '../../src/health/indicator.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A probe-less store (custom arm). */
function probeLessStore(): IIdempotencyStore {
  return {
    name: 'custom',
    connect: () => Promise.resolve(),
    claim: () => Promise.resolve({ outcome: 'claimed', takeover: false }),
    complete: () => Promise.resolve('settled'),
    release: () => Promise.resolve('lost'),
  };
}

/** A store with a probe. */
function probingStore(reachable: boolean | (() => Promise<boolean>)): IIdempotencyStore {
  return {
    ...probeLessStore(),
    name: 'redis',
    isHealthy: typeof reachable === 'function' ? reachable : () => Promise.resolve(reachable),
  };
}

describe('createIdempotencyIndicator (M109a §3.14)', () => {
  it('reports down before connect and after close, for every arm', async () => {
    let state: IdempotencyLifecycleState = 'pending';
    const indicator = createIdempotencyIndicator(
      probingStore(true),
      createClockRuntime(),
      () => state,
    );
    expect((await indicator()).status).toBe('down');
    state = 'connected';
    expect((await indicator()).status).toBe('up');
    state = 'closed';
    expect((await indicator()).status).toBe('down');
  });

  it('reports up with reachable "unknown" when the store has no probe', async () => {
    const indicator = createIdempotencyIndicator(
      probeLessStore(),
      createClockRuntime(),
      () => 'connected',
    );
    const result = await indicator();
    expect(result.status).toBe('up');
    expect(result.data?.reachable).toBe('unknown');
  });

  it('reports the probe outcome', async () => {
    const up = createIdempotencyIndicator(
      probingStore(true),
      createClockRuntime(),
      () => 'connected',
    );
    expect((await up()).data?.reachable).toBe(true);
    const down = createIdempotencyIndicator(
      probingStore(false),
      createClockRuntime(),
      () => 'connected',
    );
    expect((await down()).status).toBe('down');
  });

  it('treats a probe timeout as unreachable', async () => {
    // A probe that never settles: the cached probe bounds it with a REAL timer
    // (the clock fixture's timers are inert) and falls back to false.
    const runtime = {
      ...createClockRuntime(),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (handle: number) => clearTimeout(handle),
    };
    const indicator = createIdempotencyIndicator(
      probingStore(() => new Promise<boolean>(() => {})),
      runtime,
      () => 'connected',
    );
    const result = await indicator();
    expect(result.status).toBe('down');
  });

  it('invokes the probe on its owner', async () => {
    let thisArg: unknown;
    const store = probingStore(true);
    const original = store.isHealthy;
    if (original === undefined) throw new Error('fixture error: no probe');
    store.isHealthy = function (this: unknown) {
      thisArg = this;
      return original.call(this);
    };
    const indicator = createIdempotencyIndicator(store, createClockRuntime(), () => 'connected');
    await indicator();
    expect(thisArg).toBe(store);
  });
});
