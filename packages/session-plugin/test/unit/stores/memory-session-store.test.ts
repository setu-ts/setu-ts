/**
 * Unit tests for the in-process session store.
 *
 * Timers are injected, so the sweep and its cleanup are asserted without waiting
 * on real time.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { TimerHandle } from '@hono-enterprise/common';

import { MemorySessionStore } from '../../../src/stores/memory-session-store.ts';

const NOW = 1_700_000_000_000;

/** A controllable clock plus a recording timer pair. */
function harness() {
  let current = NOW;
  const timers: { fn: () => void; ms: number; handle: TimerHandle }[] = [];
  const cleared: TimerHandle[] = [];
  let nextHandle = 1;

  const store = new MemorySessionStore({
    now: () => current,
    setInterval: (fn, ms) => {
      const handle = nextHandle++ as unknown as TimerHandle;
      timers.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
    sweepIntervalMs: 5_000,
  });

  return {
    store,
    timers,
    cleared,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('MemorySessionStore', () => {
  it('reads back what it writes', async () => {
    const { store } = harness();
    await store.write('s-1', { userId: 'u-1' }, 60_000);
    expect(await store.read('s-1')).toEqual({ userId: 'u-1' });
  });

  it('returns null for an unknown id', async () => {
    const { store } = harness();
    expect(await store.read('nope')).toBe(null);
  });

  it('returns a detached copy so a caller cannot rewrite stored state', async () => {
    const { store } = harness();
    await store.write('s-1', { nested: 'v' }, 60_000);

    const first = await store.read('s-1') as Record<string, unknown>;
    first['nested'] = 'mutated';

    expect(await store.read('s-1')).toEqual({ nested: 'v' });
  });

  it('does not keep a reference to the written object', async () => {
    const { store } = harness();
    const data = { a: 1 };
    await store.write('s-1', data, 60_000);
    data.a = 2;
    expect(await store.read('s-1')).toEqual({ a: 1 });
  });

  it('expires an entry on read once its TTL has passed', async () => {
    const h = harness();
    await h.store.write('s-1', { a: 1 }, 1_000);

    h.advance(1_001);
    expect(await h.store.read('s-1')).toBe(null);
    // Dropped, not merely hidden.
    expect(h.store.size).toBe(0);
  });

  it('expires an entry exactly at its TTL boundary', async () => {
    const h = harness();
    await h.store.write('s-1', { a: 1 }, 1_000);
    h.advance(1_000);
    expect(await h.store.read('s-1')).toBe(null);
  });

  it('destroys an entry and reports whether one was removed', async () => {
    const { store } = harness();
    await store.write('s-1', { a: 1 }, 60_000);

    expect(await store.destroy('s-1')).toBe(true);
    expect(await store.destroy('s-1')).toBe(false);
    expect(await store.read('s-1')).toBe(null);
  });

  it('overwrites an existing entry', async () => {
    const { store } = harness();
    await store.write('s-1', { v: 1 }, 60_000);
    await store.write('s-1', { v: 2 }, 60_000);
    expect(await store.read('s-1')).toEqual({ v: 2 });
    expect(store.size).toBe(1);
  });

  it('reports healthy', async () => {
    const { store } = harness();
    expect(await store.isHealthy()).toBe(true);
  });

  it('arms one sweep timer at the configured interval', () => {
    const h = harness();
    expect(h.timers.length).toBe(1);
    expect(h.timers[0].ms).toBe(5_000);
  });

  it('sweeps expired entries and keeps live ones', async () => {
    const h = harness();
    await h.store.write('short', { a: 1 }, 1_000);
    await h.store.write('long', { a: 2 }, 60_000);

    h.advance(2_000);
    // Drive the registered callback, exactly as the runtime would.
    h.timers[0].fn();

    expect(h.store.size).toBe(1);
    expect(await h.store.read('long')).toEqual({ a: 2 });
  });

  it('clears the timer on close so the process can exit', async () => {
    const h = harness();
    await h.store.write('s-1', { a: 1 }, 60_000);

    await h.store.close();

    expect(h.cleared).toEqual([h.timers[0].handle]);
    expect(h.store.size).toBe(0);
  });

  it('defaults the sweep interval when none is given', () => {
    const timers: number[] = [];
    new MemorySessionStore({
      now: () => NOW,
      setInterval: (_fn, ms) => {
        timers.push(ms);
        return 1 as unknown as TimerHandle;
      },
      clearInterval: () => {},
    });
    expect(timers).toEqual([60_000]);
  });
});
