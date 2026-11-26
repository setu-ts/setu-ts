import { expect, it, vi } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
import type { ServiceInstance } from '@setu-ts/common';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeProvider, createFakeRuntime, instance } from '../fixtures/fakes.ts';
import { RecordingLogger } from '../../../common/test/fixtures/redis-connection-errors.ts';

async function flush(): Promise<void> {
  for (let n = 0; n < 50; n++) await Promise.resolve();
}
const a = instance({ id: 'a' });
const b = instance({ id: 'b' });
function setup() {
  const provider = createFakeProvider([a]);
  const runtime = createFakeRuntime();
  const logger = new RecordingLogger();
  const warnings: unknown[] = [];
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    undefined,
    (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
    (_name, error) => {
      warnings.push(error);
    },
  );
  return { provider, runtime, logger, warnings, service };
}

it('does not start queued provider watch setup after close', async () => {
  const { service, provider } = setup();
  const watch = vi.spyOn(provider, 'watch');
  const pending = service.watch('billing', () => {});
  service.close();
  await pending;
  expect(watch).not.toHaveBeenCalled();
});
it('reapplies the empty-only cache cap as watched names stop', async () => {
  const { service, provider } = setup();
  provider.setInstances([]);
  const stops: (() => void)[] = [];
  for (let n = 0; n < 270; n++) {
    const name = `empty-${n}`;
    stops.push(await service.watch(name, () => {}));
    provider.emit(name, []);
  }
  expect(service.cachedServices).toBe(270);
  for (const stop of stops.slice(0, 14)) stop();
  expect(service.cachedServices).toBe(256);
  // Still-watched names survive trimming, including the oldest watched name.
  const calls = provider.resolveCalls;
  await service.resolve('empty-14');
  await flush();
  expect(provider.resolveCalls).toBe(calls + 1); // warm refresh, not eviction/re-watch
  for (const stop of stops.slice(14)) stop();
  expect(service.cachedServices).toBeLessThanOrEqual(256);
  service.close();
});
it('isolates rejecting thenables, warns once and clears the failure after fulfillment', async () => {
  const { service, provider, warnings } = setup();
  let reject = true;
  const error = new Error('async listener');
  await service.watch('billing', () => (reject ? Promise.reject(error) : Promise.resolve()));
  const seen: unknown[] = [];
  await service.watch('billing', (list) => seen.push(list));
  provider.emit('billing', [a]);
  await flush();
  provider.emit('billing', [b]);
  await flush();
  expect(warnings).toEqual([error]);
  expect(seen).toHaveLength(2);
  expect(service.degraded).toBe(false);
  reject = false;
  provider.emit('billing', [a]);
  await flush();
  reject = true;
  provider.emit('billing', [b]);
  await flush();
  expect(warnings).toEqual([error, error]);
  service.close();
});
for (const action of ['unsubscribe', 'close'] as const) {
  it(`skips a snapshotted subscriber removed by an earlier listener (${action})`, async () => {
    const { service, provider } = setup();
    let stopB = () => {};
    const seen: unknown[] = [];
    await service.watch('billing', () => {
      if (action === 'close') service.close();
      else stopB();
    });
    stopB = await service.watch('billing', (list) => seen.push(list));
    provider.emit('billing', [a]);
    expect(seen).toEqual([]);
    service.close();
  });
}
it('preserves a warm failure reporter across more than 256 cold failures', async () => {
  const { service, provider, runtime, logger } = setup();
  await service.resolve('billing');
  provider.failWith(new Error('down'));
  await service.resolve('billing');
  await flush();
  for (let n = 0; n < 257; n++) await expect(service.resolve(`cold-${n}`)).rejects.toThrow();
  runtime.advance(1000);
  await service.resolve('billing');
  await flush();
  expect(logger.forSource('billing').map((e) => e.level)).toEqual(['warn', 'debug']);
  provider.failWith(null);
  runtime.advance(2000);
  await service.resolve('billing');
  await flush();
  expect(logger.forSource('billing').map((e) => e.level)).toEqual(['warn', 'debug', 'info']);
  service.close();
});
it('preserves the served list age while an empty refresh is held', async () => {
  const { service, provider, runtime } = setup();
  await service.resolve('billing');
  await flush();
  runtime.advance(100);
  provider.setInstances([]);
  await service.resolve('billing');
  await flush();
  runtime.advance(100);
  provider.failWith(new Error('down'));
  await service.resolve('billing');
  await flush();
  expect(service.staleForMs).toBe(200);
  service.close();
});
it('compares accessor-backed instance fields and leaves equal lists unchanged', async () => {
  const { service, provider } = setup();
  class AccessorInstance implements ServiceInstance {
    get id() {
      return 'accessor';
    }
    get serviceName() {
      return 'billing';
    }
    get host() {
      return this.#address;
    }
    get port() {
      return 80;
    }
    readonly #address: string;
    constructor(address: string) {
      this.#address = address;
    }
  }
  const seen: unknown[] = [];
  await service.watch('billing', (list) => seen.push(list.map((i) => i.host)));
  for (const host of ['one', 'two', 'two']) {
    provider.setInstances([new AccessorInstance(host)]);
    await service.resolve('billing');
    await flush();
  }
  expect(seen).toEqual([['one'], ['two']]);
  service.close();
});
it('does not open an outage or log recovery for a failed read superseded by a watch', async () => {
  const watched = createFakeProvider([a]);
  let reject!: (reason: unknown) => void;
  let fail = true;
  const provider = {
    ...watched,
    resolve: () =>
      fail
        ? new Promise<readonly ServiceInstance[]>((_r, r) => {
            reject = r;
          })
        : Promise.resolve([b]),
  };
  const runtime = createFakeRuntime();
  const logger = new RecordingLogger();
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    undefined,
    (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
  );
  await service.watch('billing', () => {});
  const pending = service.resolve('billing');
  await flush();
  watched.emit('billing', [b]);
  reject(new Error('superseded'));
  expect(await pending).toEqual([b]);
  fail = false;
  await service.resolve('billing');
  await flush();
  expect(logger.entries).toEqual([]);
  expect(service.degraded).toBe(false);
  service.close();
});
for (const pending of [false, true]) {
  it(`releases watch sequences only after an unwatched read settles (pending=${pending})`, async () => {
    const watched = createFakeProvider([a]);
    let finish!: (list: readonly ServiceInstance[]) => void;
    const provider = {
      ...watched,
      resolve: () =>
        new Promise<readonly ServiceInstance[]>((resolve) => {
          finish = resolve;
        }),
    };
    const service = new ServiceDiscoveryService(
      provider,
      createFakeRuntime(),
      resolveOptions({ provider: 'custom', discovery: provider }),
    );
    const candidates: Map<unknown, unknown>[] = [];
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (key === 'tracked' && typeof value === 'number') candidates.push(this);
      return set.call(this, key, value);
    });
    try {
      const stop = await service.watch('tracked', () => {});
      const read = pending ? service.resolve('tracked') : undefined;
      await flush();
      watched.emit('tracked', [b]);
      spy.mockRestore();
      const sequences = candidates.at(-1);
      expect(sequences?.has('tracked')).toBe(true);
      stop();
      expect(sequences?.has('tracked')).toBe(pending);
      if (read !== undefined) {
        finish([a]);
        expect(await read).toEqual([b]);
        await flush();
      }
      expect(sequences?.has('tracked')).toBe(false);
    } finally {
      spy.mockRestore();
      service.close();
    }
  });
}

it('compares every instance field, including optional collections and metadata key order', async () => {
  const { service, provider } = setup();
  const seen: unknown[] = [];
  await service.watch('billing', (list) => seen.push(list));
  const base = {
    ...a,
    secure: true,
    weight: 2,
    tags: ['a', 'b'],
    metadata: { zone: 'one', rack: 'two' },
  };
  const rows: readonly (readonly ServiceInstance[])[] = [
    [base],
    [{ ...base, metadata: { rack: 'two', zone: 'one' } }],
    [{ ...base, id: 'new' }],
    [{ ...base, serviceName: 'other' }],
    [{ ...base, port: 9090 }],
    [{ ...base, secure: false }],
    [{ ...base, weight: 3 }],
    [{ ...base, tags: ['a'] }],
    [{ ...base, tags: ['b', 'a'] }],
    [{ ...base, metadata: { zone: 'changed', rack: 'two' } }],
    [{ ...base, metadata: { zone: 'one' } }],
    [a],
    [base],
    [a, b],
    [a],
  ];
  for (const list of rows) {
    provider.setInstances(list);
    await service.resolve('billing');
    await flush();
  }
  expect(seen).toHaveLength(rows.length - 1);
  service.close();
});

for (const outcome of ['success', 'failure'] as const) {
  it(`keeps a newer empty watch answer when teardown evicts its cache during a pending ${outcome}`, async () => {
    const watched = createFakeProvider([]);
    let finish!: (list: readonly ServiceInstance[]) => void;
    let reject!: (error: Error) => void;
    const provider = {
      ...watched,
      resolve: () =>
        new Promise<readonly ServiceInstance[]>((yes, no) => {
          finish = yes;
          reject = no;
        }),
    };
    const logger = new RecordingLogger();
    const service = new ServiceDiscoveryService(
      provider,
      createFakeRuntime(),
      resolveOptions({ provider: 'custom', discovery: provider }),
      undefined,
      (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
    );
    const read = service.resolve('first');
    await flush();
    const stop = await service.watch('first', () => {});
    watched.emit('first', []);
    for (let n = 0; n < 256; n++) {
      const name = `watched-${n}`;
      await service.watch(name, () => {});
      watched.emit(name, []);
    }
    stop();
    if (outcome === 'success') finish([a]);
    else reject(new Error('superseded'));
    await expect(read).resolves.toEqual([]);
    expect(service.cachedServices).toBe(256);
    expect(logger.entries).toEqual([]);
    service.close();
  });
}

for (const older of ['reject', 'fulfill'] as const) {
  it(`ignores an older listener ${older} after a newer delivery settled`, async () => {
    const { service, provider, warnings } = setup();
    const stale = new Error('superseded rejection');
    const current = new Error('current rejection');
    const other = new Error('other listener failed');
    let rejectOlder!: (error: Error) => void;
    let fulfillOlder!: () => void;
    let finishNewest!: () => void;
    let calls = 0;
    await service.watch('billing', () => {
      calls++;
      if (calls === 1) return new Promise<void>((resolve, reject) => { fulfillOlder = resolve; rejectOlder = reject; });
      if (calls === 2) return older === 'reject' ? Promise.resolve() : Promise.reject(current);
      return new Promise<void>((resolve) => { finishNewest = resolve; });
    });
    let otherFails = false;
    await service.watch('billing', () => { if (otherFails) throw other; });
    provider.emit('billing', [a]);
    provider.emit('billing', [b]);
    await flush();
    if (older === 'reject') rejectOlder(stale); else fulfillOlder();
    await flush();
    otherFails = true;
    provider.emit('billing', [a]);
    await flush();
    expect(warnings).toEqual([older === 'reject' ? other : current]);
    expect(service.degraded).toBe(false);
    finishNewest(); await flush(); service.close();
  });
}
