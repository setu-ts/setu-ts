import { describe, expect, it } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeProvider, createFakeRuntime, instance } from '../fixtures/fakes.ts';
import { RecordingLogger } from '../../../common/test/fixtures/redis-connection-errors.ts';

async function flush(): Promise<void> {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
const a = instance({ id: 'a' });
const b = instance({ id: 'b' });

describe.each(['read', 'watch'] as const)('listener isolation on %s', (path) => {
  it('delivers to other subscribers without degrading discovery, warning once until recovery', async () => {
    const runtime = createFakeRuntime();
    const provider = createFakeProvider([a]);
    const logger = new RecordingLogger();
    const warnings: { name: string; error: unknown }[] = [];
    const error = new Error('consumer failed');
    let broken = true;
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
      undefined,
      (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
      (name, error) => {
        warnings.push({ name, error });
      },
    );
    const stopBad = await service.watch('billing', () => {
      if (broken) throw error;
    });
    const seen: string[][] = [];
    await service.watch('billing', (list) => seen.push(list.map((i) => i.id)));
    const deliver = async (list: readonly (typeof a)[]) => {
      provider.setInstances(list);
      if (path === 'watch') provider.emit('billing', list);
      else {
        await service.resolve('billing');
        await flush();
      }
    };
    await deliver([a]);
    await deliver([b]);
    expect(seen).toEqual([['a'], ['b']]);
    expect(service.degraded).toBe(false);
    expect(service.staleForMs).toBe(0);
    expect(logger.entries).toEqual([]);
    expect(warnings).toEqual([{ name: 'billing', error }]);
    broken = false;
    await deliver([a]);
    broken = true;
    await deliver([b]);
    expect(warnings).toHaveLength(2);
    stopBad();
    await service.watch('billing', () => {
      throw error;
    }); // Cached replay is isolated too.
    expect(warnings).toHaveLength(3);
    expect(service.degraded).toBe(false);
    service.close();
  });
});

it('isolates a throwing diagnostic callback as well as a throwing subscriber', async () => {
  const provider = createFakeProvider([a]);
  const service = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider }),
    undefined,
    undefined,
    () => {
      throw new Error('logger failed');
    },
  );
  await service.watch('billing', () => {
    throw new Error('listener failed');
  });
  let delivered = false;
  await service.watch('billing', () => {
    delivered = true;
  });
  await expect(service.resolve('billing')).resolves.toEqual([a]);
  expect(delivered).toBe(true);
  expect(service.degraded).toBe(false);
  service.close();
});
