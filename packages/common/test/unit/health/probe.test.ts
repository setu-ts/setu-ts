import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createCachedProbe } from '../../../src/health/probe.ts';
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
