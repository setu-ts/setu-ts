/**
 * Unit tests for the M98i cache operation counters: option validation, the
 * collector's counting, saturation, retention and failure latch, the
 * observation wrapper's transparency (results, null semantics, original
 * rejection identity, synchronous throws), and the plugin's source
 * registration and close ordering through a real kernel application.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  CacheDiagnosticsSnapshot,
  ICacheDiagnosticsSource,
  ICacheStore,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { CachePlugin, CacheService } from '../../src/index.ts';
import { attachCacheCollector, detachCacheCollector } from '../../src/services/cache-service.ts';
import type { CacheDiagnosticsOptions } from '../../src/index.ts';
import type { CacheStore } from '../../src/stores/cache-store.ts';
import { MemoryStore } from '../../src/stores/memory-store.ts';
import { NoopStore } from '../../src/stores/noop-store.ts';
import {
  bump,
  CACHE_COLLECTOR_LIMITS,
  CACHE_DIAGNOSTICS_ERRORS,
  CacheObservationCollector,
  compileCacheDiagnosticsAlias,
  createCacheDiagnosticsSource,
  UNTIMED,
} from '../../src/diagnostics/cache-observations.ts';

/** A controllable monotonic clock. */
class Clock {
  now = 1_000;
  reads = 0;
  fail = false;
  read = (): number => {
    this.reads++;
    if (this.fail) {
      throw new Error('clock-canary');
    }
    return this.now;
  };
}

/** A backend whose every method can be scripted to resolve, reject or throw. */
function scriptedBackend(
  mode: 'resolve' | 'reject' | 'throw',
  error: unknown,
  values: { get?: unknown; has?: boolean; delete?: boolean } = {},
): CacheStore {
  const act = <T>(value: T): Promise<T> => {
    if (mode === 'throw') {
      throw error;
    }
    return mode === 'reject' ? Promise.reject(error) : Promise.resolve(value);
  };
  return {
    get: () => act(values.get ?? null),
    set: () => act(undefined),
    delete: () => act(values.delete ?? false),
    has: () => act(values.has ?? false),
    clear: () => act(undefined),
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
  } as unknown as CacheStore;
}

/** Builds an observed service over a backend. */
function observed(backend: CacheStore, clock = new Clock()) {
  const service = new CacheService(backend, 'p:');
  const collector = new CacheObservationCollector('primary', clock.read);
  attachCacheCollector(service, collector);
  return { service, collector, clock };
}

/** The record for one operation. */
function recordOf(snapshot: CacheDiagnosticsSnapshot, operation: string) {
  return snapshot.records.find((r) => r.operation === operation);
}

type Op = 'get' | 'set' | 'delete' | 'has' | 'clear';

/** Invokes one operation. */
function call(service: CacheService, op: Op): Promise<unknown> {
  switch (op) {
    case 'get':
      return service.get('k');
    case 'set':
      return service.set('k', 'v');
    case 'delete':
      return service.delete('k');
    case 'has':
      return service.has('k');
    default:
      return service.clear();
  }
}

const OPS: readonly Op[] = ['get', 'set', 'delete', 'has', 'clear'];

describe('compileCacheDiagnosticsAlias', () => {
  it('accepts the literal-true opt-in and returns the alias', () => {
    expect(compileCacheDiagnosticsAlias({ enabled: true, alias: 'primary' })).toBe('primary');
    expect(compileCacheDiagnosticsAlias({ enabled: true, alias: 'x'.repeat(64) })).toHaveLength(64);
  });

  it('refuses every invalid shape with a fixed, value-free message', () => {
    const cases: readonly [unknown, string][] = [
      [null, CACHE_DIAGNOSTICS_ERRORS.shape],
      [[], CACHE_DIAGNOSTICS_ERRORS.shape],
      ['x', CACHE_DIAGNOSTICS_ERRORS.shape],
      [{ enabled: false, alias: 'a' }, CACHE_DIAGNOSTICS_ERRORS.enabled],
      [{ enabled: true, alias: 7 }, CACHE_DIAGNOSTICS_ERRORS.aliasType],
      [{ enabled: true, alias: '' }, CACHE_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ enabled: true, alias: 'x'.repeat(65) }, CACHE_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ enabled: true, alias: 'a\u001bb' }, CACHE_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a\u0085b' }, CACHE_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a', keys: ['secret'] }, CACHE_DIAGNOSTICS_ERRORS.extraKey],
    ];
    for (const [input, message] of cases) {
      expect(() => compileCacheDiagnosticsAlias(input as CacheDiagnosticsOptions)).toThrow(message);
    }
  });

  it('refuses at CachePlugin() construction, before any application exists', () => {
    expect(() =>
      CachePlugin({ diagnostics: { enabled: false } as unknown as CacheDiagnosticsOptions })
    ).toThrow(CACHE_DIAGNOSTICS_ERRORS.enabled);
  });
});

describe('observeCacheCall — outcome counters', () => {
  for (const op of OPS) {
    it(`${op}: one fulfilled call counts once as succeeded`, async () => {
      const { service, collector } = observed(scriptedBackend('resolve', null));
      await call(service, op);
      expect(recordOf(collector.snapshot(), op)).toMatchObject({
        alias: 'primary',
        count: 1,
        succeeded: 1,
        failed: 0,
      });
    });

    it(`${op}: one rejection counts once as failed and keeps the original reason`, async () => {
      const reason = new Error('reject-canary');
      const { service, collector } = observed(scriptedBackend('reject', reason));
      await expect(call(service, op)).rejects.toBe(reason);
      const record = recordOf(collector.snapshot(), op)!;
      expect(record).toMatchObject({ count: 1, succeeded: 0, failed: 1 });
      // A failed call never increments a detail counter.
      expect(record.hits + record.misses + record.present + record.absent).toBe(0);
      expect(record.removed + record.notRemoved).toBe(0);
    });

    it(`${op}: a synchronous backend throw counts as failed and rethrows synchronously`, () => {
      const reason = new Error('throw-canary');
      const { service, collector } = observed(scriptedBackend('throw', reason));
      let caught: unknown;
      try {
        void call(service, op);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(reason);
      expect(recordOf(collector.snapshot(), op)).toMatchObject({ count: 1, failed: 1 });
    });
  }

  it('classifies null get as a successful miss and non-null as a hit', async () => {
    const miss = observed(scriptedBackend('resolve', null, { get: null }));
    expect(await miss.service.get('k')).toBeNull();
    const hit = observed(scriptedBackend('resolve', null, { get: 0 }));
    expect(await hit.service.get('k')).toBe(0);
    expect(recordOf(miss.collector.snapshot(), 'get')).toMatchObject({
      succeeded: 1,
      misses: 1,
      hits: 0,
    });
    expect(recordOf(hit.collector.snapshot(), 'get')).toMatchObject({ hits: 1, misses: 0 });
  });

  it('classifies has and delete detail counters on success only', async () => {
    const yes = observed(scriptedBackend('resolve', null, { has: true, delete: true }));
    await yes.service.has('k');
    await yes.service.delete('k');
    const no = observed(scriptedBackend('resolve', null, { has: false, delete: false }));
    await no.service.has('k');
    await no.service.delete('k');
    expect(recordOf(yes.collector.snapshot(), 'has')).toMatchObject({ present: 1, absent: 0 });
    expect(recordOf(yes.collector.snapshot(), 'delete')).toMatchObject({
      removed: 1,
      notRemoved: 0,
    });
    expect(recordOf(no.collector.snapshot(), 'has')).toMatchObject({ present: 0, absent: 1 });
    expect(recordOf(no.collector.snapshot(), 'delete')).toMatchObject({
      removed: 0,
      notRemoved: 1,
    });
  });

  it('keeps count equal to succeeded + failed across mixed outcomes', async () => {
    let fail = false;
    const backend = scriptedBackend('resolve', null);
    const flaky = {
      ...backend,
      get: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve('v')),
    } as unknown as CacheStore;
    const { service, collector } = observed(flaky);
    await service.get('a');
    fail = true;
    await service.get('a').catch(() => {});
    fail = false;
    await service.get('a');
    const record = recordOf(collector.snapshot(), 'get')!;
    expect(record.count).toBe(3);
    expect(record.succeeded + record.failed).toBe(record.count);
    expect(record).toMatchObject({ succeeded: 2, failed: 1, hits: 2 });
  });

  // M101a V8-5: a bounded Redis command REJECTS rather than parking the call,
  // and that rejection is the recorded failure — no new collector code. The
  // reason is ioredis's own `commandTimeout` error text.
  it('counts a command-timeout rejection as failed, never as a miss', async () => {
    const clock = new Clock();
    const timedOut = new Error('Command timed out');
    const backend = {
      ...scriptedBackend('resolve', null),
      get: () => {
        clock.now += 1000;
        return Promise.reject(timedOut);
      },
    } as unknown as CacheStore;
    const { service, collector } = observed(backend, clock);
    await expect(service.get('k')).rejects.toBe(timedOut);
    expect(recordOf(collector.snapshot(), 'get')).toMatchObject({
      count: 1,
      succeeded: 0,
      failed: 1,
      hits: 0,
      misses: 0,
    });
  });

  it('measures integer durations on the monotonic clock and clamps a negative delta', async () => {
    const clock = new Clock();
    let release: () => void = () => {};
    const slow = {
      ...scriptedBackend('resolve', null),
      set: () => new Promise<void>((resolve) => (release = resolve)),
    } as unknown as CacheStore;
    const { service, collector } = observed(slow, clock);
    const pending = service.set('k', 'v');
    clock.now += 12.6;
    release();
    await pending;
    expect(recordOf(collector.snapshot(), 'set')!.lastDurationMs).toBe(13);

    const backwards = observed(slow, clock);
    const again = backwards.service.set('k', 'v');
    clock.now -= 50;
    release();
    await again;
    expect(recordOf(backwards.collector.snapshot(), 'set')!.lastDurationMs).toBe(0);
  });
});

describe('observeCacheCall — transparency', () => {
  it('returns the backend promise unobserved, and one settling identically observed', async () => {
    const direct = Promise.resolve('same');
    const backend = {
      ...scriptedBackend('resolve', null),
      get: () => direct,
    } as unknown as CacheStore;
    const plain = new CacheService(backend, '');
    // Unobserved: no wrapping at all.
    expect(plain.get('k')).toBe(direct);
    // Observed: a derived promise (so an unhandled rejection stays unhandled)
    // that settles to the same value.
    const { service } = observed(backend);
    const wrapped = service.get('k');
    expect(wrapped).not.toBe(direct);
    expect(await wrapped).toBe('same');
  });

  it('reads no clock on a service whose plugin did not opt in', async () => {
    const clock = new Clock();
    const service = new CacheService(new MemoryStore('', { clock: () => 0 }), '');
    const collector = new CacheObservationCollector('x', clock.read);
    attachCacheCollector(service, collector);
    detachCacheCollector(service);
    await service.set('k', 'v');
    await service.get('k');
    expect(clock.reads).toBe(0);
  });

  it('preserves TTL, prefix, getOrSet coalescing and factory counts enabled, disabled and failing', async () => {
    const run = async (mode: 'disabled' | 'enabled' | 'failing') => {
      const calls: string[] = [];
      const inner = new MemoryStore('');
      const spy = {
        get: (key: string) => {
          calls.push(`get:${key}`);
          return inner.get(key);
        },
        set: (key: string, value: unknown, ttl?: number) => {
          calls.push(`set:${key}:${ttl}`);
          return inner.set(key, value, ttl);
        },
      } as unknown as CacheStore;
      const service = new CacheService(spy, 'pre:', 30);
      if (mode !== 'disabled') {
        const clock = new Clock();
        // `failing`: the observer's clock throws on every read.
        clock.fail = mode === 'failing';
        attachCacheCollector(service, new CacheObservationCollector('a', clock.read));
      }
      let factoryRuns = 0;
      const factory = async () => {
        factoryRuns++;
        await Promise.resolve();
        return { n: 1 };
      };
      const results = await Promise.all([
        service.getOrSet('k', factory),
        service.getOrSet('k', factory),
        service.getOrSet('k', factory),
      ]);
      const failure = new Error('factory-canary');
      const rejected = await service.getOrSet('z', () => Promise.reject(failure)).catch((e) => e);
      return { calls, factoryRuns, results, rejected, failure };
    };
    const off = await run('disabled');
    expect(off.calls).toContain('set:pre:k:30');
    expect(off.factoryRuns).toBe(1);
    for (const mode of ['enabled', 'failing'] as const) {
      const other = await run(mode);
      expect(other.calls).toEqual(off.calls);
      expect(other.factoryRuns).toBe(1);
      expect(other.results).toEqual(off.results);
      expect(other.rejected).toBe(other.failure);
    }
  });

  it('leaves an unhandled backend rejection unhandled, exactly as when unobserved', async () => {
    // A fire-and-forget call whose backend rejects must still surface as an
    // unhandled rejection with diagnostics on: observing settlement must
    // never mark the caller's promise as handled and swallow the error.
    const count = async (enabled: boolean): Promise<number> => {
      const reason = new Error('fire-and-forget');
      const { service } = enabled
        ? observed(scriptedBackend('reject', reason))
        : { service: new CacheService(scriptedBackend('reject', reason), '') };
      let unhandled = 0;
      const onUnhandled = (event: PromiseRejectionEvent): void => {
        if (event.reason === reason) {
          unhandled++;
          event.preventDefault();
        }
      };
      globalThis.addEventListener('unhandledrejection', onUnhandled);
      try {
        void service.get('k');
        // The runtime reports an unhandled rejection on a later turn of the
        // event loop, and how many turns later depends on load (one turn
        // flaked on CI), so wait turn by turn up to a bound rather than once.
        for (let turn = 0; turn < 200 && unhandled === 0; turn++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        globalThis.removeEventListener('unhandledrejection', onUnhandled);
      }
      return unhandled;
    };
    expect(await count(false)).toBe(1);
    expect(await count(true)).toBe(1);
  });

  it('keeps the settlement order of interleaved calls identical enabled and disabled', async () => {
    const run = async (enabled: boolean) => {
      // Each backend call resolves when its gate is released; gates are
      // released in a fixed, non-FIFO order.
      const gates: (() => void)[] = [];
      const gated = <T>(value: T) => new Promise<T>((resolve) => gates.push(() => resolve(value)));
      const backend = {
        ...scriptedBackend('resolve', null),
        get: () => gated('v'),
        set: () => gated(undefined),
        has: () => gated(true),
        delete: () => gated(false),
      } as unknown as CacheStore;
      const service = new CacheService(backend, '');
      if (enabled) {
        attachCacheCollector(service, new CacheObservationCollector('a', new Clock().read));
      }
      const order: string[] = [];
      const calls = [
        service.get('a').then(() => order.push('get')),
        service.set('a', 1).then(() => order.push('set')),
        service.has('a').then(() => order.push('has')),
        service.delete('a').then(() => order.push('delete')),
      ];
      for (const index of [2, 0, 3, 1]) {
        gates[index]!();
      }
      await Promise.all(calls);
      return order;
    };
    const off = await run(false);
    expect(off).toEqual(['has', 'get', 'delete', 'set']);
    expect(await run(true)).toEqual(off);
  });

  it('keeps results and errors unchanged when the observer itself fails', async () => {
    const clock = new Clock();
    const store = new MemoryStore('');
    const { service, collector } = observed(store as unknown as CacheStore, clock);
    clock.fail = true;
    await service.set('k', 'v');
    expect(await service.get('k')).toBe('v');
    expect(collector.snapshot()).toEqual({
      state: 'collection-failed',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
    // Latched: capture has stopped even once the clock recovers.
    clock.fail = false;
    await service.set('k', 'v');
    expect(collector.snapshot().state).toBe('collection-failed');
  });

  it('latches collection-failed when the clock fails mid-settle', async () => {
    const clock = new Clock();
    const { service, collector } = observed(scriptedBackend('resolve', null), clock);
    let reads = 0;
    const failing = new CacheObservationCollector('b', () => {
      reads++;
      if (reads === 2) {
        throw new Error('settle-clock');
      }
      return 5;
    });
    attachCacheCollector(service, failing);
    await service.get('k');
    expect(failing.snapshot().state).toBe('collection-failed');
    expect(collector.snapshot().state).toBe('no-data');
  });

  it('reports noop as a legitimate miss-producing implementation', async () => {
    const { service, collector } = observed(new NoopStore('') as unknown as CacheStore);
    expect(await service.get('k')).toBeNull();
    expect(recordOf(collector.snapshot(), 'get')).toMatchObject({ misses: 1, failed: 0 });
  });
});

describe('CacheObservationCollector — sampled timing', () => {
  it('times the first call per operation and one in every eight after it', async () => {
    const clock = new Clock();
    const collector = new CacheObservationCollector('a', clock.read);
    const interval = CACHE_COLLECTOR_LIMITS.timingSampleInterval;
    const starts = Array.from({ length: interval * 2 + 1 }, () => collector.begin('get'));
    const timed = starts.map((start) => start !== UNTIMED);
    expect(timed.filter(Boolean).length).toBe(3);
    expect(timed[0]).toBe(true);
    expect(timed[interval]).toBe(true);
    expect(timed[interval * 2]).toBe(true);
    // Each operation cycles independently: set's first call is timed.
    expect(collector.begin('set')).not.toBe(UNTIMED);
    // Every call, timed or not, is still counted.
    for (const start of starts) {
      collector.settle('get', start, 'hit');
    }
    expect(collector.snapshot().records[0]).toMatchObject({ count: interval * 2 + 1, hits: 17 });
    await Promise.resolve();
  });

  it('keeps the last TIMED duration across untimed calls', () => {
    const clock = new Clock();
    const collector = new CacheObservationCollector('a', clock.read);
    const timed = collector.begin('get');
    clock.now += 7;
    collector.settle('get', timed, 'hit');
    const untimed = collector.begin('get');
    expect(untimed).toBe(UNTIMED);
    clock.now += 500;
    collector.settle('get', untimed, 'miss');
    expect(collector.snapshot().records[0]).toMatchObject({
      count: 2,
      lastDurationMs: 7,
      ageMs: 0,
    });
  });

  it('reports a null duration when a retention reset lands on an untimed call', () => {
    const clock = new Clock();
    const collector = new CacheObservationCollector('a', clock.read);
    collector.settle('get', collector.begin('get'), 'hit');
    const untimed = collector.begin('get');
    clock.now += CACHE_COLLECTOR_LIMITS.retentionMs + 1;
    collector.settle('get', untimed, 'hit');
    expect(collector.snapshot().records[0]).toMatchObject({ count: 1, lastDurationMs: null });
  });
});

describe('CacheObservationCollector — retention, state and bounds', () => {
  it('reports no-data, ready, stale, and expires records after 60 s', async () => {
    const clock = new Clock();
    const { service, collector } = observed(scriptedBackend('resolve', null), clock);
    expect(collector.snapshot().state).toBe('no-data');
    await service.get('k');
    expect(collector.snapshot().state).toBe('ready');
    clock.now += CACHE_COLLECTOR_LIMITS.staleMs + 1;
    const stale = collector.snapshot();
    expect(stale.state).toBe('stale');
    expect(stale.records[0]!.ageMs).toBe(CACHE_COLLECTOR_LIMITS.staleMs + 1);
    clock.now += CACHE_COLLECTOR_LIMITS.retentionMs;
    expect(collector.snapshot()).toMatchObject({ state: 'no-data', records: [] });
  });

  it('resets an expired record on its next observation', async () => {
    const clock = new Clock();
    const { service, collector } = observed(scriptedBackend('resolve', null), clock);
    await service.get('k');
    await service.get('k');
    clock.now += CACHE_COLLECTOR_LIMITS.retentionMs + 1;
    await service.get('k');
    expect(recordOf(collector.snapshot(), 'get')!.count).toBe(1);
  });

  it('saturates every counter at Number.MAX_SAFE_INTEGER', () => {
    expect(bump(0)).toBe(1);
    expect(bump(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns deeply frozen snapshots with exactly the contract keys', async () => {
    const { service, collector } = observed(scriptedBackend('resolve', null));
    await service.clear();
    const snapshot = collector.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.keys(snapshot).sort()).toEqual(
      ['alias', 'coverage', 'dropped', 'records', 'state'],
    );
    expect(Object.keys(snapshot.records[0]!).length).toBe(13);
    expect(snapshot.records[0]).toMatchObject({ hits: 0, misses: 0, present: 0, absent: 0 });
  });

  it('reports disabled once closed and ignores late settlements', async () => {
    let release: () => void = () => {};
    const slow = {
      ...scriptedBackend('resolve', null),
      get: () => new Promise((resolve) => (release = () => resolve('v'))),
    } as unknown as CacheStore;
    const { service, collector } = observed(slow);
    const pending = service.get('k');
    collector.close();
    release();
    expect(await pending).toBe('v');
    expect(collector.snapshot()).toMatchObject({ state: 'disabled', alias: null, records: [] });
    expect(collector.begin('get')).toBeNull();
  });

  it('answers disabled from a source without a collector', () => {
    expect(createCacheDiagnosticsSource(null).snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('answers collection-failed when the clock fails at read time', () => {
    const clock = new Clock();
    const collector = new CacheObservationCollector('a', clock.read);
    clock.fail = true;
    expect(collector.snapshot().state).toBe('collection-failed');
    expect(collector.begin('get')).toBeNull();
    // A settle with a null start is ignored.
    collector.settle('get', null, 'hit');
    expect(collector.snapshot().records).toEqual([]);
  });
});

describe('CachePlugin — diagnostics source registration (real kernel)', () => {
  async function start(plugins: ReturnType<typeof CachePlugin>[]) {
    const app = createApplication({ plugins: [RuntimePlugin(), ...plugins] });
    await app.start();
    return app;
  }

  it('registers one multi source per instance without claiming the token in provides', async () => {
    const primary = CachePlugin({ diagnostics: { enabled: true, alias: 'primary' } });
    const named = CachePlugin({ name: 'session' });
    expect(primary.provides).toEqual([CAPABILITIES.CACHE]);
    const app = await start([primary, named]);
    try {
      const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
      await cache.set('k', 'v');
      const sources = app.services.getAll<ICacheDiagnosticsSource>(
        CAPABILITIES.CACHE_DIAGNOSTICS,
      );
      expect(sources.length).toBe(2);
      expect(sources[0]!.snapshot()).toMatchObject({ state: 'ready', alias: 'primary' });
      expect(sources[1]!.snapshot().state).toBe('disabled');
    } finally {
      await app.stop();
    }
  });

  it('covers only the owned service: a replacement is never observed or instantiated', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), CachePlugin({ diagnostics: { enabled: true, alias: 'p' } })],
    });
    await app.start();
    try {
      const owned = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
      const replacement = new CacheService(new MemoryStore(''), '');
      await replacement.set('k', 'v');
      await owned.get('absent');
      const [source] = app.services.getAll<ICacheDiagnosticsSource>(
        CAPABILITIES.CACHE_DIAGNOSTICS,
      );
      const snapshot = source!.snapshot();
      expect(snapshot.coverage).toBe('owned-instance');
      expect(snapshot.records.map((r) => r.operation)).toEqual(['get']);
    } finally {
      await app.stop();
    }
  });

  it('detaches and clears on close: later calls are unobserved and the source is disabled', async () => {
    const app = await start([CachePlugin({ diagnostics: { enabled: true, alias: 'p' } })]);
    const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
    await cache.get('k');
    const [source] = app.services.getAll<ICacheDiagnosticsSource>(
      CAPABILITIES.CACHE_DIAGNOSTICS,
    );
    await app.stop();
    expect(source!.snapshot()).toMatchObject({ state: 'disabled', records: [] });
  });

  it('never reports an eviction: a MemoryStore LRU eviction is counted as a later miss only', async () => {
    const app = await start([
      CachePlugin({ options: { maxSize: 1 }, diagnostics: { enabled: true, alias: 'p' } }),
    ]);
    try {
      const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
      await cache.set('a', 1);
      await cache.set('b', 2);
      expect(await cache.get('a')).toBeNull();
      const [source] = app.services.getAll<ICacheDiagnosticsSource>(
        CAPABILITIES.CACHE_DIAGNOSTICS,
      );
      const json = JSON.stringify(source!.snapshot());
      expect(json).not.toContain('evict');
      expect(source!.snapshot().records.find((r) => r.operation === 'get')).toMatchObject({
        misses: 1,
      });
    } finally {
      await app.stop();
    }
  });
});
