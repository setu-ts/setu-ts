import { describe, expect, it } from 'vitest';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeProvider, createFakeRuntime, instance } from '../fixtures/fakes.ts';

async function flush(): Promise<void> {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
const a = instance({ id: 'a' });
const b = instance({ id: 'b' });

describe.each(['dns-fingerprint', 'kubernetes-deleted'])('one empty delivery from %s', (kind) => {
  it('expires the held answer and updates every subscriber once without another watch delivery', async () => {
    const runtime = createFakeRuntime();
    const fake = createFakeProvider([a]);
    const provider = { ...fake, kind };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({
        provider: 'custom',
        discovery: provider,
        cacheTtlMs: 1000,
        emptyAnswerGraceMs: 100,
        resolveTimeoutMs: 0,
      }),
    );
    const seen: string[][][] = [[], []];
    const stop1 = await service.watch('billing', (list) => seen[0]!.push(list.map((i) => i.id)));
    fake.emit('billing', [a]);
    const stop2 = await service.watch('billing', (list) => seen[1]!.push(list.map((i) => i.id)));
    seen[0]!.length = 0;
    seen[1]!.length = 0;
    fake.setInstances([]);
    fake.emit('billing', []);
    expect(seen).toEqual([[['a']], [['a']]]);
    expect(service.degraded).toBe(true);
    const grace = runtime.timeouts.filter((timer) => !timer.cleared);
    expect(grace).toHaveLength(1);
    runtime.advance(100);
    grace[0]!.cleared = true;
    grace[0]!.fn();
    await flush();
    expect(seen).toEqual([
      [['a'], []],
      [['a'], []],
    ]);
    expect(await service.resolve('billing')).toEqual([]);
    expect(service.degraded).toBe(false);
    expect(runtime.timeouts.every((timer) => timer.cleared)).toBe(true);
    stop1();
    expect(fake.unsubscribeCalls).toBe(0);
    stop2();
    expect(fake.unsubscribeCalls).toBe(1);
    stop2();
    service.close();
  });
});

it('broadcasts read changes once, preserves repeated watch deliveries, resets grace and clears timers on close', async () => {
  const runtime = createFakeRuntime();
  const provider = createFakeProvider([a]);
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({
      provider: 'custom',
      discovery: provider,
      cacheTtlMs: 0,
      emptyAnswerGraceMs: 100,
      resolveTimeoutMs: 0,
    }),
  );
  const seen: string[][] = [];
  await service.watch('billing', (list) => seen.push(list.map((i) => i.id)));
  await service.resolve('billing');
  provider.setInstances([b]);
  await service.resolve('billing');
  await flush();
  expect(seen).toEqual([['a'], ['b']]);
  provider.emit('billing', [b]);
  expect(seen).toEqual([['a'], ['b'], ['b']]);
  provider.emit('billing', []);
  expect(runtime.timeouts.filter((timer) => !timer.cleared)).toHaveLength(1);
  provider.emit('billing', [a]);
  expect(runtime.timeouts.every((timer) => timer.cleared)).toBe(true);
  provider.emit('billing', []);
  const late = runtime.timeouts.at(-1)!;
  service.close();
  expect(runtime.timeouts.every((timer) => timer.cleared)).toBe(true);
  const count = seen.length;
  late.fn();
  provider.emit('billing', [a]);
  await flush();
  expect(seen).toHaveLength(count);
  expect(service.cachedServices).toBe(0);
});

it('coalesces a grace-expiry read and retries failed expiry reads with normal spacing', async () => {
  const runtime = createFakeRuntime();
  const fake = createFakeProvider([a]);
  let reads = 0;
  let finish!: (list: readonly (typeof a)[]) => void;
  let fail = false;
  const provider = {
    ...fake,
    resolve: () => {
      reads++;
      return fail
        ? Promise.reject(new Error('down'))
        : new Promise<readonly (typeof a)[]>((resolve) => {
            finish = resolve;
          });
    },
  };
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({
      provider: 'custom',
      discovery: provider,
      cacheTtlMs: 0,
      emptyAnswerGraceMs: 100,
      resolveTimeoutMs: 0,
    }),
  );
  const seen: unknown[] = [];
  await service.watch('billing', (list) => seen.push(list));
  fake.emit('billing', [a]);
  fake.emit('billing', []);
  await service.resolve('billing');
  await flush();
  runtime.advance(100);
  runtime.runTimeouts();
  await flush();
  expect(reads).toBe(1);
  finish([]);
  await flush();
  expect(seen.at(-1)).toEqual([]);
  fake.emit('billing', [a]);
  fake.emit('billing', []);
  fail = true;
  runtime.advance(100);
  runtime.runTimeouts();
  await flush();
  expect(reads).toBe(2);
  expect(runtime.timeouts.at(-1)?.ms).toBe(1000);
  fail = false;
  runtime.advance(1000);
  runtime.runTimeouts();
  await flush();
  expect(reads).toBe(3);
  finish([]);
  await flush();
  expect(seen.at(-1)).toEqual([]);
  service.close();
});

it('cleans up a failed backend watch and refuses to start watches after close', async () => {
  const provider = {
    ...createFakeProvider(),
    watch: () => Promise.reject(new Error('watch down')),
  };
  const service = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider }),
  );
  await expect(service.watch('billing', () => {})).rejects.toThrow('watch down');
  expect(service.watchedServices).toBe(0);
  service.close();
  const stop = await service.watch('billing', () => {});
  stop();
});
