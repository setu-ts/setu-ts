import { describe, expect, it } from 'vitest';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeProvider, createFakeRuntime } from '../fixtures/fakes.ts';

describe('ServiceDiscoveryService reachability probe', () => {
  it('coalesces 50 concurrent isHealthy reads and caches one provider probe for 5 s', async () => {
    const runtime = createFakeRuntime();
    let calls = 0;
    let answer: (value: boolean) => void = () => {};
    const provider = {
      ...createFakeProvider(),
      isHealthy: () => {
        calls++;
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'static', services: {} }),
    );
    const reads = Array.from({ length: 50 }, () => service.isHealthy());
    await Promise.resolve();
    expect(calls).toBe(1);
    answer(true);
    expect(await Promise.all(reads)).toEqual(Array<boolean>(50).fill(true));
    runtime.advance(4999);
    expect(await service.isHealthy()).toBe(true);
    expect(calls).toBe(1);
    runtime.advance(1);
    const next = service.isHealthy();
    await Promise.resolve();
    expect(calls).toBe(2);
    answer(false);
    expect(await next).toBe(false);
    expect(await service.isHealthy()).toBe(false);
    expect(calls).toBe(2);
    expect(runtime.timeouts.every((timer) => timer.cleared)).toBe(true);
  });

  it('returns false at the 2 s bound for a never-settling provider', async () => {
    const runtime = createFakeRuntime();
    const service = new ServiceDiscoveryService(
      { ...createFakeProvider(), isHealthy: () => new Promise<boolean>(() => {}) },
      runtime,
      resolveOptions({ provider: 'static', services: {} }),
    );
    let settled = false;
    const read = service.isHealthy().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(runtime.timeouts).toHaveLength(1);
    expect(runtime.timeouts[0]).toMatchObject({ ms: 2000, cleared: false });
    runtime.advance(1999);
    expect(settled).toBe(false);
    runtime.advance(1);
    runtime.runTimeouts();
    expect(await read).toBe(false);
    expect(await service.isHealthy()).toBe(false);
    expect(runtime.timeouts).toHaveLength(1);
  });

  it.each(['throw', 'reject'] as const)(
    'returns false when the raw probe fails: %s',
    async (mode) => {
      const runtime = createFakeRuntime();
      const service = new ServiceDiscoveryService(
        {
          ...createFakeProvider(),
          isHealthy: () => {
            if (mode === 'throw') throw new Error('probe failed');
            return Promise.reject(new Error('probe failed'));
          },
        },
        runtime,
        resolveOptions({ provider: 'static', services: {} }),
      );
      expect(await service.isHealthy()).toBe(false);
      expect(runtime.timeouts[0]?.cleared).toBe(true);
    },
  );

  it('treats a provider without a probe as reachable', async () => {
    const service = new ServiceDiscoveryService(
      createFakeProvider(),
      createFakeRuntime(),
      resolveOptions({ provider: 'static', services: {} }),
    );
    expect(await service.isHealthy()).toBe(true);
  });
});
