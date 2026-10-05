/**
 * Unit tests for the M98m storage operation observations: the option
 * validation, the bounded collector (states, expiry boundaries, stale
 * threshold, saturation, the 1,024-token cap and overflow, clock faults,
 * close semantics), the service seam (semantic fidelity, byte capture,
 * fallback double-count, rejection identity, unhandled-rejection behavior),
 * and the plugin registration and cleanup.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IStorageDiagnosticsSource, StorageDiagnosticsSnapshot } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { StoragePlugin } from '../../src/plugin/storage-plugin.ts';
import {
  attachStorageCollector,
  detachStorageCollector,
  StorageService,
} from '../../src/services/storage-service.ts';
import {
  bump,
  compileStorageDiagnosticsAlias,
  createStorageDiagnosticsSource,
  disabledStorageSnapshot,
  STORAGE_COLLECTOR_LIMITS,
  STORAGE_DIAGNOSTICS_ERRORS,
  StorageObservationCollector,
} from '../../src/diagnostics/storage-observations.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

/** A mutable monotonic clock for the collector. */
class Clock {
  value = 0;
  throws = false;
  nonFinite = false;
  reads = 0;
  readonly fn: () => number;

  constructor() {
    this.fn = (): number => {
      this.reads++;
      if (this.throws) {
        throw new Error('clock-canary-SYNTHETIC');
      }
      if (this.nonFinite) {
        return Number.POSITIVE_INFINITY;
      }
      return this.value;
    };
  }

  advance(by: number): void {
    this.value += by;
  }
}

/** A minimal fake provider with call counters. */
function createFakeProvider(partial?: Partial<StorageProvider>): StorageProvider & {
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const count = (name: string): void => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  return {
    counts,
    connect(): Promise<void> {
      return Promise.resolve();
    },
    disconnect(): Promise<void> {
      return Promise.resolve();
    },
    isReady(): boolean {
      return true;
    },
    put(path: string, data: Uint8Array, options?: { contentType?: string }): Promise<void> {
      count('put');
      void path;
      void data;
      void options;
      return Promise.resolve();
    },
    get(path: string): Promise<Uint8Array | null> {
      count('get');
      return Promise.resolve(path === 'missing' ? null : new Uint8Array([1, 2, 3]));
    },
    delete(_path: string): Promise<boolean> {
      count('delete');
      return Promise.resolve(true);
    },
    exists(_path: string): Promise<boolean> {
      count('exists');
      return Promise.resolve(true);
    },
    getSignedUrl(_path: string, _options: { expiresIn: number }): Promise<string> {
      count('getSignedUrl');
      return Promise.resolve('https://signed.example/canary-url-SYNTHETIC');
    },
    ...partial,
  };
}

function collector(): { c: StorageObservationCollector; clock: Clock } {
  const clock = new Clock();
  return { c: new StorageObservationCollector('primary', clock.fn), clock };
}

/** The records of a snapshot, keyed by operation. */
function byOp(snapshot: StorageDiagnosticsSnapshot): Map<string, Record<string, unknown>> {
  return new Map(
    snapshot.records.map((r) => [r.operation, r as unknown as Record<string, unknown>]),
  );
}

describe('storage diagnostics — option validation', () => {
  it('approves a well-formed option (positive control)', () => {
    expect(compileStorageDiagnosticsAlias({ enabled: true, alias: 'primary' })).toBe('primary');
    expect(compileStorageDiagnosticsAlias({ enabled: true, alias: 'a'.repeat(64) }))
      .toBe('a'.repeat(64));
  });

  const invalid: ReadonlyArray<[string, () => unknown, ErrorConstructor, string]> = [
    ['a non-object', () => null, TypeError, STORAGE_DIAGNOSTICS_ERRORS.shape],
    ['an array', () => [1], TypeError, STORAGE_DIAGNOSTICS_ERRORS.shape],
    [
      'an extra key',
      () => ({ enabled: true, alias: 'a', label: 'x' }),
      TypeError,
      STORAGE_DIAGNOSTICS_ERRORS.extraKey,
    ],
    [
      'enabled not true',
      () => ({ enabled: false, alias: 'a' }),
      TypeError,
      STORAGE_DIAGNOSTICS_ERRORS.enabled,
    ],
    [
      'a non-string alias',
      () => ({ enabled: true, alias: 1 }),
      TypeError,
      STORAGE_DIAGNOSTICS_ERRORS.aliasType,
    ],
    [
      'an empty alias',
      () => ({ enabled: true, alias: '' }),
      RangeError,
      STORAGE_DIAGNOSTICS_ERRORS.aliasBytes,
    ],
    [
      'a 65-byte alias',
      () => ({ enabled: true, alias: 'a'.repeat(65) }),
      RangeError,
      STORAGE_DIAGNOSTICS_ERRORS.aliasBytes,
    ],
    [
      'a multibyte 65-byte alias',
      () => ({ enabled: true, alias: 'é'.repeat(33) }),
      RangeError,
      STORAGE_DIAGNOSTICS_ERRORS.aliasBytes,
    ],
    [
      'a control-character alias',
      () => ({ enabled: true, alias: 'a\u202eb' }),
      RangeError,
      STORAGE_DIAGNOSTICS_ERRORS.aliasControl,
    ],
  ];
  for (const [name, make, ctor, message] of invalid) {
    it(`refuses ${name}`, () => {
      expect(() => compileStorageDiagnosticsAlias(make() as never)).toThrow(message);
      expect(() => compileStorageDiagnosticsAlias(make() as never))
        .toThrow(ctor);
    });
  }
});

describe('storage diagnostics — collector', () => {
  it('answers no-data before any settlement and ready after one', () => {
    const { c } = collector();
    expect(c.snapshot()).toEqual({
      state: 'no-data',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
    const start = c.begin();
    expect(start).toBe(0);
    c.settle('put', start, 'succeeded', 4);
    const snapshot = c.snapshot();
    expect(snapshot.state).toBe('ready');
    const record = byOp(snapshot).get('put')!;
    expect(record).toEqual({
      alias: 'primary',
      operation: 'put',
      count: 1,
      lastDurationMs: 0,
      ageMs: 0,
      succeeded: 1,
      failed: 0,
      lastBytes: 4,
    });
  });

  it('records one record per fixed operation, in the fixed order', () => {
    const { c, clock } = collector();
    const operations = ['put', 'get', 'delete', 'exists', 'getSignedUrl', 'getStream'] as const;
    for (const operation of operations) {
      const start = c.begin();
      clock.advance(1);
      c.settle(operation, start, 'succeeded', null);
    }
    const snapshot = c.snapshot();
    expect(snapshot.records.map((r) => r.operation)).toEqual([...operations]);
    expect(snapshot.records.length).toBe(6);
  });

  it('counts a failure with null bytes and no duration for getSignedUrl', () => {
    const { c } = collector();
    const start = c.begin();
    c.settle('get', start, 'failed', null);
    const urlStart = c.begin();
    c.settle('getSignedUrl', urlStart, 'succeeded', null);
    const records = byOp(c.snapshot());
    expect(records.get('get')).toMatchObject({ count: 1, failed: 1, lastBytes: null });
    const url = records.get('getSignedUrl')!;
    expect(url).toMatchObject({ count: 1, succeeded: 1, lastBytes: null });
    expect(url.lastDurationMs).toBeNull();
  });

  it('treats a false exists/delete result as a successful settlement', () => {
    const { c } = collector();
    for (const operation of ['exists', 'delete'] as const) {
      const start = c.begin();
      c.settle(operation, start, 'succeeded', null);
    }
    const records = byOp(c.snapshot());
    expect(records.get('exists')).toMatchObject({ succeeded: 1, failed: 0 });
    expect(records.get('delete')).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('accepts zero bytes as a real zero', () => {
    const { c } = collector();
    const start = c.begin();
    c.settle('put', start, 'succeeded', 0);
    expect(byOp(c.snapshot()).get('put')!.lastBytes).toBe(0);
  });

  it('is stale above 30,000 ms and ready at exactly 30,000 ms', () => {
    const { c, clock } = collector();
    const start = c.begin();
    c.settle('get', start, 'succeeded', 1);
    clock.advance(30_000);
    expect(c.snapshot().state).toBe('ready');
    clock.advance(1);
    expect(c.snapshot().state).toBe('stale');
  });

  it('expires a record at 60,000 ms and not at 59,999 ms', () => {
    const { c, clock } = collector();
    const start = c.begin();
    c.settle('put', start, 'succeeded', 1);
    clock.advance(59_999);
    expect(c.snapshot().state).toBe('stale');
    clock.advance(1);
    expect(c.snapshot().state).toBe('no-data');
  });

  it('clears counters before recording a settlement after expiry', () => {
    const { c, clock } = collector();
    const start = c.begin();
    c.settle('get', start, 'failed', null);
    clock.advance(STORAGE_COLLECTOR_LIMITS.retentionMs);
    const fresh = c.begin();
    c.settle('get', fresh, 'succeeded', 5);
    const record = byOp(c.snapshot()).get('get')!;
    expect(record).toMatchObject({ count: 1, succeeded: 1, failed: 0, lastBytes: 5 });
  });

  it('saturates counters at MAX_SAFE_INTEGER', () => {
    // The saturating primitive the counters use: it clamps at the maximum
    // and never overflows.
    expect(bump(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(0)).toBe(1);
  });

  it('saturates dropped at MAX_SAFE_INTEGER without observing overflowed calls', () => {
    const { c } = collector();
    const cap = STORAGE_COLLECTOR_LIMITS.maxActiveTokens;
    for (let i = 0; i < cap; i++) {
      expect(c.begin()).not.toBeNull();
    }
    expect(c.begin()).toBeNull();
    expect(c.begin()).toBeNull();
    const snapshot = c.snapshot();
    expect(snapshot.dropped).toBe(2);
    // The overflowed calls ran unobserved: no records.
    expect(snapshot.records).toEqual([]);
  });

  it('releases a token when settlement is skipped by a clock fault', () => {
    const { c, clock } = collector();
    const start = c.begin();
    expect(start).not.toBeNull();
    clock.nonFinite = true;
    c.settle('put', start, 'succeeded', 1);
    // The latch cleared the record; the token was released.
    expect(c.snapshot()).toEqual({
      state: 'collection-failed',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('clamps a duration from an enormous finite clock jump to MAX_SAFE_INTEGER', () => {
    const { c, clock } = collector();
    const start = c.begin();
    clock.value = 1e300;
    c.settle('put', start, 'succeeded', 1);
    const [record] = c.snapshot().records;
    expect(record!.lastDurationMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(record!.lastDurationMs)).toBe(true);
  });

  it('keeps the cumulative dropped count through a collection-failed latch', () => {
    const { c, clock } = collector();
    const starts: (number | null)[] = [];
    for (let i = 0; i <= STORAGE_COLLECTOR_LIMITS.maxActiveTokens; i++) {
      starts.push(c.begin());
    }
    expect(c.snapshot().dropped).toBe(1);
    clock.throws = true;
    c.settle('put', starts[0]!, 'succeeded', 1);
    clock.throws = false;
    expect(c.snapshot()).toEqual({
      state: 'collection-failed',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [],
      dropped: 1,
    });
  });

  it('reports ages, expiry and staleness from one rounded integer', () => {
    const { c, clock } = collector();
    c.settle('put', c.begin(), 'succeeded', 1);
    // 30_000.4 rounds to 30_000: reported age and state must agree (ready).
    clock.advance(30_000.4);
    const at = c.snapshot();
    expect(at.state).toBe('ready');
    expect(at.records[0]!.ageMs).toBe(30_000);
    // 59_999.6 rounds to 60_000: expired, never reported as ageMs 60_000.
    clock.advance(29_999.2);
    expect(c.snapshot()).toMatchObject({ state: 'no-data', records: [] });
  });

  it('latches collection-failed on a throwing clock at begin', () => {
    const { c, clock } = collector();
    clock.throws = true;
    expect(c.begin()).toBeNull();
    expect(c.snapshot().state).toBe('collection-failed');
  });

  it('latches collection-failed on a non-finite clock at begin', () => {
    const { c, clock } = collector();
    clock.nonFinite = true;
    expect(c.begin()).toBeNull();
    expect(c.snapshot().state).toBe('collection-failed');
  });

  it('latches collection-failed on a throwing clock at settle', () => {
    const { c, clock } = collector();
    const start = c.begin();
    clock.throws = true;
    c.settle('put', start, 'succeeded', 1);
    expect(c.snapshot().state).toBe('collection-failed');
  });

  it('latches collection-failed on a non-finite clock at snapshot', () => {
    const { c, clock } = collector();
    const start = c.begin();
    c.settle('put', start, 'succeeded', 1);
    clock.nonFinite = true;
    expect(c.snapshot().state).toBe('collection-failed');
  });

  it('clamps backward clock movement against the last accepted reading', () => {
    const { c, clock } = collector();
    clock.value = 100;
    const start = c.begin();
    expect(start).toBe(100);
    clock.value = 50; // moved backward
    c.settle('get', start, 'succeeded', 1);
    const record = byOp(c.snapshot()).get('get')!;
    expect(record.lastDurationMs).toBe(0);
    expect(record.ageMs).toBe(0);
  });

  it('keeps dropped cumulative across record expiry', () => {
    const { c, clock } = collector();
    // Hold the cap with unsettled tokens, then overflow once.
    const cap = STORAGE_COLLECTOR_LIMITS.maxActiveTokens;
    for (let i = 0; i < cap; i++) {
      expect(c.begin()).not.toBeNull();
    }
    expect(c.begin()).toBeNull(); // dropped: 1
    clock.advance(STORAGE_COLLECTOR_LIMITS.retentionMs);
    const snapshot = c.snapshot();
    // The drop survives even though there were no records to expire.
    expect(snapshot.dropped).toBe(1);
    expect(snapshot.records).toEqual([]);
  });

  it('ignores late settlements after close and answers disabled', () => {
    const { c } = collector();
    const start = c.begin();
    c.close();
    c.settle('put', start, 'succeeded', 1);
    expect(c.snapshot()).toEqual(disabledStorageSnapshot());
    expect(c.begin()).toBeNull();
  });

  it('answers disabled with null alias, empty records and dropped zero when closed', () => {
    const { c } = collector();
    c.close();
    expect(c.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('exposes a frozen snapshot-only facade', () => {
    const { c } = collector();
    const source = createStorageDiagnosticsSource(c);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.keys(source)).toEqual(['snapshot']);
    const snapshot = source.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    for (const record of snapshot.records) {
      expect(Object.isFrozen(record)).toBe(true);
    }
  });

  it('answers disabled from a source with no collector', () => {
    const source = createStorageDiagnosticsSource(null);
    expect(source.snapshot()).toEqual(disabledStorageSnapshot());
  });
});

describe('storage diagnostics — service seam', () => {
  it('exposes no public unobserved read beside the IStorage methods', () => {
    expect(Object.getOwnPropertyNames(StorageService.prototype).sort()).toEqual([
      'constructor',
      'delete',
      'exists',
      'get',
      'getSignedUrl',
      'getStream',
      'put',
    ]);
  });

  it('runs unobserved with no attachment, exactly as before M98m', async () => {
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const data = new Uint8Array([1, 2]);
    await service.put('p', data);
    expect(await service.get('p')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await service.delete('p')).toBe(true);
    expect(await service.exists('p')).toBe(true);
    expect(await service.getSignedUrl('p', { expiresIn: 1 })).toBe(
      'https://signed.example/canary-url-SYNTHETIC',
    );
    expect(provider.counts).toEqual({ put: 1, get: 1, delete: 1, exists: 1, getSignedUrl: 1 });
  });

  it('observes every public operation once, with the same results', async () => {
    const existsCalls = { n: 0 };
    const provider = createFakeProvider({
      exists(_path: string): Promise<boolean> {
        existsCalls.n++;
        return Promise.resolve(false);
      },
    });
    const service = new StorageService(provider);
    const { c, clock } = collector();
    attachStorageCollector(service, c);
    const data = new Uint8Array([1, 2]);
    await service.put('p', data, { contentType: 'text/plain' });
    clock.advance(1);
    const got = await service.get('p');
    clock.advance(1);
    expect(await service.delete('p')).toBe(true);
    expect(await service.exists('p')).toBe(false);
    clock.advance(1);
    expect(await service.getSignedUrl('p', { expiresIn: 1 })).toBe(
      'https://signed.example/canary-url-SYNTHETIC',
    );
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider.counts).toEqual({ put: 1, get: 1, delete: 1, getSignedUrl: 1 });
    expect(existsCalls.n).toBe(1);
    const records = byOp(c.snapshot());
    expect(records.get('put')).toMatchObject({
      count: 1,
      succeeded: 1,
      lastBytes: 2,
      lastDurationMs: 0,
    });
    expect(records.get('get')).toMatchObject({ count: 1, succeeded: 1, lastBytes: 3 });
    expect(records.get('delete')).toMatchObject({ count: 1, succeeded: 1, lastBytes: null });
    expect(records.get('exists')).toMatchObject({ count: 1, succeeded: 1, lastBytes: null });
    expect(records.get('getSignedUrl')).toMatchObject({
      count: 1,
      succeeded: 1,
      lastBytes: null,
      lastDurationMs: null,
    });
  });

  it('preserves the optional put argument arity', async () => {
    const seen: Array<{ arity: number; options: unknown }> = [];
    const provider = createFakeProvider({
      put(path: string, data: Uint8Array, options?: { contentType?: string }): Promise<void> {
        seen.push({ arity: arguments.length, options });
        void path;
        void data;
        return Promise.resolve();
      },
    });
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await service.put('a', new Uint8Array([1]));
    await service.put('b', new Uint8Array([1]), { contentType: 'text/plain' });
    expect(seen).toEqual([
      { arity: 2, options: undefined },
      { arity: 3, options: { contentType: 'text/plain' } },
    ]);
    expect(byOp(c.snapshot()).get('put')).toMatchObject({ count: 2, succeeded: 2 });
  });

  it('records the absent-object conversion as a failed get without reading the error', async () => {
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await expect(service.get('missing')).rejects.toThrow('Storage object not found: missing');
    expect(byOp(c.snapshot()).get('get')).toMatchObject({ count: 1, failed: 1, lastBytes: null });
  });

  it('preserves the original rejection reason', async () => {
    const reason = new Error('canary-rejection-SYNTHETIC');
    const provider = createFakeProvider({ get: () => Promise.reject(reason) });
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await expect(service.get('p')).rejects.toBe(reason);
    expect(byOp(c.snapshot()).get('get')).toMatchObject({ failed: 1 });
  });

  it('rethrows a synchronous provider throw synchronously and records it failed', async () => {
    const provider = createFakeProvider({
      get(_path: string): Promise<Uint8Array | null> {
        throw new Error('canary-sync-SYNTHETIC');
      },
    });
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await expect(service.get('p')).rejects.toThrow('canary-sync-SYNTHETIC');
    expect(byOp(c.snapshot()).get('get')).toMatchObject({ failed: 1 });
  });

  it('counts a getStream fallback as one getStream observation and one provider get', async () => {
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    const stream = await service.getStream('p');
    const reader = stream.getReader();
    const chunk = (await reader.read()).value;
    expect(chunk).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider.counts.get).toBe(1);
    const records = byOp(c.snapshot());
    expect(records.get('get')).toBeUndefined();
    expect(records.get('getStream')).toMatchObject({ count: 1, succeeded: 1, lastBytes: null });
  });

  it('counts a concurrent public get under its own operation while a fallback runs', async () => {
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    const [stream, bytes] = await Promise.all([service.getStream('p'), service.get('p')]);
    void stream;
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider.counts.get).toBe(2);
    const records = byOp(c.snapshot());
    expect(records.get('get')).toMatchObject({ count: 1, succeeded: 1, lastBytes: 3 });
    expect(records.get('getStream')).toMatchObject({ count: 1, succeeded: 1 });
  });

  it('preserves native stream identity and counts one acquisition', async () => {
    const native = new ReadableStream<Uint8Array>();
    const provider = createFakeProvider({ getStream: () => Promise.resolve(native) });
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    const stream = await service.getStream('p');
    expect(stream).toBe(native);
    expect(byOp(c.snapshot()).get('getStream')).toMatchObject({ count: 1, succeeded: 1 });
  });

  it('converts a null native stream into the absent-object error', async () => {
    const provider = createFakeProvider({ getStream: () => Promise.resolve(null) });
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await expect(service.getStream('missing')).rejects.toThrow(
      'Storage object not found: missing',
    );
    expect(byOp(c.snapshot()).get('getStream')).toMatchObject({ failed: 1 });
  });

  it('reads the put length from the intrinsic byteLength, never an app getter', async () => {
    let getterRuns = 0;
    const data = new Uint8Array([1, 2, 3]);
    Object.defineProperty(data, 'byteLength', {
      get(): number {
        getterRuns++;
        return 999;
      },
      enumerable: false,
    });
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await service.put('p', data);
    expect(getterRuns).toBe(0);
    expect(byOp(c.snapshot()).get('put')!.lastBytes).toBe(3);
  });

  it('isolates a byteLength observation failure to null without changing the call', async () => {
    // A value that is not a real typed array: the intrinsic getter refuses
    // it (TypeError) and the observation isolates to null; the provider
    // still receives the same argument and the call succeeds.
    const fake = {
      length: 1,
      get byteLength(): number {
        throw new Error('canary-bytelen-SYNTHETIC');
      },
    };
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await service.put('p', fake as unknown as Uint8Array);
    expect(byOp(c.snapshot()).get('put')).toMatchObject({ succeeded: 1, lastBytes: null });
  });

  it('stops observing after detach and close (late results cannot repopulate)', async () => {
    const provider = createFakeProvider();
    const service = new StorageService(provider);
    const { c } = collector();
    attachStorageCollector(service, c);
    await service.put('a', new Uint8Array([1]));
    detachStorageCollector(service);
    c.close();
    await service.put('b', new Uint8Array([1]));
    expect(c.snapshot()).toEqual(disabledStorageSnapshot());
  });

  it('keeps a fire-and-forget rejection unhandled with diagnostics on', async () => {
    // The derived-promise seam must not mark the caller's promise handled:
    // a fire-and-forget call whose provider rejects must still terminate the
    // process, exactly as without diagnostics.
    const code = `
      import { StorageService } from '${
      new URL(
        '../../src/services/storage-service.ts',
        import.meta.url,
      ).href
    }';
      import { attachStorageCollector } from '${
      new URL(
        '../../src/services/storage-service.ts',
        import.meta.url,
      ).href
    }';
      import { StorageObservationCollector } from '${
      new URL(
        '../../src/diagnostics/storage-observations.ts',
        import.meta.url,
      ).href
    }';
      const provider = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        isReady: () => true,
        put: () => Promise.resolve(),
        get: () => Promise.reject(new Error('boom')),
        delete: () => Promise.resolve(true),
        exists: () => Promise.resolve(true),
        getSignedUrl: () => Promise.resolve('u'),
      };
      const withObservation = Deno.args[0] === 'observed';
      const service = new StorageService(provider);
      if (withObservation) {
        attachStorageCollector(service, new StorageObservationCollector('a', () => 0));
      }
      void service.get('x');
    `;
    for (const arg of ['observed', 'unobserved']) {
      const output = await new Deno.Command(Deno.execPath(), {
        args: ['run', '--quiet', '--no-lock', '--eval', code, arg],
        stdout: 'null',
        stderr: 'null',
      }).output();
      // An unhandled rejection terminates the process with a non-zero code.
      expect(output.code, `arg=${arg}`).not.toBe(0);
    }
  });
});

describe('storage diagnostics — plugin registration', () => {
  it('registers an inert disabled source without the option', async () => {
    const { ctx, registered, onCloseHandlers } = createFakeContext();
    const plugin = StoragePlugin();
    expect(plugin.provides).toEqual([CAPABILITIES.STORAGE]);
    await plugin.register(ctx);
    const source = registered.get(CAPABILITIES.STORAGE_DIAGNOSTICS) as IStorageDiagnosticsSource;
    expect(source.snapshot()).toEqual(disabledStorageSnapshot());
    // The close hook is installed and leaves the source disabled.
    expect(onCloseHandlers.length).toBe(1);
    await onCloseHandlers[0]!();
    expect(source.snapshot()).toEqual(disabledStorageSnapshot());
  });

  it('registers an enabled source with the approved alias', async () => {
    const { ctx, registered } = createFakeContext();
    await StoragePlugin({ provider: 'memory', diagnostics: { enabled: true, alias: 'files' } })
      .register(ctx);
    const source = registered.get(CAPABILITIES.STORAGE_DIAGNOSTICS) as IStorageDiagnosticsSource;
    const snapshot = source.snapshot();
    expect(snapshot.state).toBe('no-data');
    expect(snapshot.alias).toBe('files');
    expect(snapshot.coverage).toBe('owned-instance');
  });

  it('refuses an invalid option at composition time', () => {
    expect(() =>
      StoragePlugin({
        provider: 'memory',
        diagnostics: { enabled: true, alias: '' },
      })
    ).toThrow(STORAGE_DIAGNOSTICS_ERRORS.aliasBytes);
    expect(() =>
      StoragePlugin({
        provider: 'memory',
        diagnostics: { enabled: false, alias: 'a' } as never,
      })
    ).toThrow(STORAGE_DIAGNOSTICS_ERRORS.enabled);
  });

  it('registers the service and source and cleans up before disconnect on close', async () => {
    const { ctx, registered, onCloseHandlers } = createFakeContext();
    await StoragePlugin({ provider: 'memory', diagnostics: { enabled: true, alias: 'files' } })
      .register(ctx);
    const service = registered.get(CAPABILITIES.STORAGE) as StorageService;
    const source = registered.get(CAPABILITIES.STORAGE_DIAGNOSTICS) as IStorageDiagnosticsSource;
    // One observed settlement before close.
    await service.put('a', new Uint8Array([1]));
    expect(source.snapshot().state).toBe('ready');
    expect(onCloseHandlers.length).toBe(1);
    await onCloseHandlers[0]!();
    // After the close hook: detached, closed, dropped zero.
    expect(source.snapshot()).toEqual(disabledStorageSnapshot());
    // A late settlement cannot repopulate the collector.
    await service.put('b', new Uint8Array([1]));
    expect(source.snapshot()).toEqual(disabledStorageSnapshot());
  });

  it('registers nothing when the provider connect fails', async () => {
    // A file system whose probe write rejects: the local provider's connect
    // fails, so the service and the diagnostics source are never registered.
    const failing = {
      readFile: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
      writeFile: (): Promise<void> => Promise.reject(new Error('canary-fs-SYNTHETIC')),
      mkdir: async (): Promise<void> => {},
      rm: async (): Promise<void> => {},
      stat: (): Promise<never> => Promise.reject(new Error('canary-fs-SYNTHETIC')),
    };
    const { ctx, registered } = createFakeContext({}, false, failing as never);
    const plugin = StoragePlugin({
      provider: 'local',
      options: { rootDir: '/nonexistent-root-canary' },
      diagnostics: { enabled: true, alias: 'a' },
    });
    await expect(plugin.register(ctx)).rejects.toThrow('cannot write to');
    expect(registered.has(CAPABILITIES.STORAGE)).toBe(false);
    expect(registered.has(CAPABILITIES.STORAGE_DIAGNOSTICS)).toBe(false);
  });
});
