import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createCachedProbe, resolveProbeTiming } from '../../../src/health/probe.ts';
import type { IRuntimeServices } from '../../../src/runtime.ts';
import type { CachedProbeOptions } from '../../../src/health/probe.ts';

class FakeClock {
  #now = 0;

  get now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  readonly fn = (): number => this.#now;
}

class Deferred {
  #resolve: (value: boolean) => void = () => {};

  readonly promise: Promise<boolean> = new Promise<boolean>((resolve) => {
    this.#resolve = resolve;
  });

  resolve(value: boolean): void {
    this.#resolve(value);
  }
}

describe('createCachedProbe', () => {
  it('bounds the probe with an INJECTED timer, not the ambient one', async () => {
    // M70c review: the timeout previously reached for the ambient setTimeout
    // while the TTL clock was injected. A custom IRuntimeServices' timers were
    // therefore bypassed — the class M51b fixed when transports reached for
    // global timers. Driving the seam with a controllable timer is what proves
    // the injected surface is actually the one used.
    const clock = new FakeClock();
    let armed: { fn: () => void; ms: number } | null = null;
    let cleared = 0;
    const never = new Promise<boolean>(() => {});

    const isHealthy = createCachedProbe({
      probe: () => never,
      timeoutMs: 1234,
      hrtime: clock.fn,
      setTimer: (fn, ms) => {
        armed = { fn, ms };
        return { handle: true };
      },
      clearTimer: () => {
        cleared++;
      },
    });

    const pending = isHealthy();
    expect(armed).not.toBeNull();
    expect(armed!.ms).toBe(1234);

    // Firing the injected timer is the only thing that can settle this probe.
    armed!.fn();
    expect(await pending).toBe(false);
    expect(cleared).toBe(1);
  });

  it('falls back to the ambient timer when no seam is injected', async () => {
    // The default arm still has to work for a caller with no runtime to hand.
    const clock = new FakeClock();
    const isHealthy = createCachedProbe({
      probe: () => new Promise<boolean>(() => {}),
      timeoutMs: 5,
      hrtime: clock.fn,
    });
    expect(await isHealthy()).toBe(false);
  });

  it('caches the outcome within the TTL: N reads issue one probe', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return Promise.resolve(true);
      },
      ttlMs: 1000,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(true);
    clock.advance(499);
    expect(await isHealthy()).toBe(true);
    clock.advance(499);
    expect(await isHealthy()).toBe(true);
    expect(calls).toBe(1);
  });

  it('re-probes once the TTL has elapsed, and re-caches the new outcome', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return Promise.resolve(calls % 2 === 1);
      },
      ttlMs: 1000,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(true); // probe #1
    clock.advance(1000); // exactly the TTL: the cached outcome is stale
    expect(await isHealthy()).toBe(false); // probe #2
    clock.advance(999);
    expect(await isHealthy()).toBe(false); // still cached from probe #2
    expect(calls).toBe(2);
  });

  it('uses the default 5000ms TTL when ttlMs is omitted', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return Promise.resolve(true);
      },
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(true);
    clock.advance(4999);
    expect(await isHealthy()).toBe(true);
    clock.advance(1); // 5000 total: stale
    expect(await isHealthy()).toBe(true);
    expect(calls).toBe(2);
  });

  it('coalesces concurrent callers into one in-flight probe', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deferred = new Deferred();
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return deferred.promise;
      },
      ttlMs: 1000,
      hrtime: clock.fn,
    });

    const first = isHealthy();
    const second = isHealthy();
    const third = isHealthy();
    deferred.resolve(true);

    await Promise.all([first, second, third]);
    expect(calls).toBe(1);
  });

  it('treats a probe exceeding timeoutMs as unreachable and caches the failure', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return new Promise<boolean>(() => {}); // never settles
      },
      ttlMs: 1000,
      timeoutMs: 20,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(false);
    clock.advance(999);
    expect(await isHealthy()).toBe(false); // the timeout outcome is cached
    expect(calls).toBe(1);
  });

  it('treats a rejecting probe as unreachable and never escapes the throw', async () => {
    const clock = new FakeClock();
    const isHealthy = createCachedProbe({
      probe: () => Promise.reject(new Error('backend down')),
      ttlMs: 1000,
      timeoutMs: 50,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(false);
  });

  it('treats a probe that throws synchronously as unreachable', async () => {
    const clock = new FakeClock();
    const isHealthy = createCachedProbe({
      probe: () => {
        throw new Error('sync');
      },
      ttlMs: 1000,
      timeoutMs: 50,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(false);
  });

  it('caches a false outcome and re-probes after the TTL recovers it to true', async () => {
    const clock = new FakeClock();
    let reachable = false;
    let calls = 0;
    const isHealthy = createCachedProbe({
      probe: () => {
        calls += 1;
        return Promise.resolve(reachable);
      },
      ttlMs: 100,
      hrtime: clock.fn,
    });

    expect(await isHealthy()).toBe(false);
    clock.advance(100);
    reachable = true;
    expect(await isHealthy()).toBe(true);
    expect(calls).toBe(2);
  });

  it('accepts the full options shape (type-level)', () => {
    const clock = new FakeClock();
    const options: CachedProbeOptions = {
      probe: () => Promise.resolve(true),
      ttlMs: 100,
      timeoutMs: 10,
      hrtime: clock.fn,
    };
    const isHealthy = createCachedProbe(options);
    expect(typeof isHealthy).toBe('function');
  });
});

describe('resolveProbeTiming', () => {
  // A runtime double carrying ONLY the three members the helper reads.
  const fakeRuntime = () => {
    const state = { now: 0, timers: [] as Array<{ ms: number }>, cleared: [] as unknown[] };
    const runtime = {
      hrtime: (): number => state.now,
      setTimeout: (_fn: () => void, ms: number): unknown => {
        state.timers.push({ ms });
        return { handle: ms };
      },
      clearTimeout: (handle: unknown): void => {
        state.cleared.push(handle);
      },
    } as unknown as IRuntimeServices;
    return { runtime, state };
  };

  it('binds every member to the injected runtime — no ambient clock exists', () => {
    // The regression this pins: the helper must not reach for
    // performance.now()/Date.now(); reading time goes through the injected
    // runtime's own hrtime, whatever it reports.
    const { runtime, state } = fakeRuntime();
    const timing = resolveProbeTiming(runtime);

    state.now = 4242;
    expect(timing.hrtime()).toBe(4242);
  });

  it('resolves the timer pair from the injected runtime', () => {
    const { runtime, state } = fakeRuntime();
    const timing = resolveProbeTiming(runtime);

    const handle = timing.setTimer(() => {}, 250);
    timing.clearTimer(handle);
    expect(state.timers).toEqual([{ ms: 250 }]);
    expect(state.cleared).toEqual([{ handle: 250 }]);
  });

  it('composes with createCachedProbe through the spread (type-level)', () => {
    const { runtime } = fakeRuntime();
    const probe = createCachedProbe({
      probe: () => Promise.resolve(true),
      ...resolveProbeTiming(runtime),
    });
    expect(typeof probe).toBe('function');
  });

  describe('a widened outcome type (V5-2)', () => {
    it('records an explicit `undefined` fallback on timeout, not `false`', async () => {
      // The bug this test exists for was in the fix, not the original: the
      // default was resolved with `options.fallback ?? false`, which cannot
      // tell an ABSENT fallback from one explicitly set to `undefined` — so
      // the tri-state caller silently got `false` back, reinstating the very
      // defect the widening exists to remove.
      let fire: (() => void) | undefined;
      const probe = createCachedProbe<boolean | undefined>({
        probe: () => new Promise<boolean>(() => {}),
        fallback: undefined,
        timeoutMs: 5,
        hrtime: () => 0,
        setTimer: (fn) => {
          fire = fn;
          return 1;
        },
        clearTimer: () => {},
      });

      const pending = probe();
      fire?.();
      expect(await pending).toBeUndefined();
    });

    it('records an explicit `undefined` fallback when the probe rejects', async () => {
      const probe = createCachedProbe<boolean | undefined>({
        probe: () => Promise.reject(new Error('unreachable')),
        fallback: undefined,
        hrtime: () => 0,
        setTimer: () => 1,
        clearTimer: () => {},
      });
      expect(await probe()).toBeUndefined();
    });

    it('still defaults to `false` when no fallback is supplied', async () => {
      // Every pre-existing caller relies on this, so the widening has to leave
      // it exactly as it was.
      const probe = createCachedProbe({
        probe: () => Promise.reject(new Error('unreachable')),
        hrtime: () => 0,
        setTimer: () => 1,
        clearTimer: () => {},
      });
      expect(await probe()).toBe(false);
    });
  });
});
