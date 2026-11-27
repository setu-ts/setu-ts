import { describe, expect, it } from 'vitest';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeProvider, createFakeRuntime, instance } from '../fixtures/fakes.ts';

async function flush(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

describe.each(['read', 'watch'] as const)('empty answers through %s', (path) => {
  for (const grace of [0, 100]) {
    it(`holds warm answers for the configured grace ${grace}, resets on nonempty, and stores cold empty`, async () => {
      const a = instance({ id: 'a' });
      const runtime = createFakeRuntime();
      const provider = createFakeProvider();
      const service = new ServiceDiscoveryService(
        provider,
        runtime,
        resolveOptions({
          provider: 'static',
          services: {},
          cacheTtlMs: 0,
          emptyAnswerGraceMs: grace,
        }),
      );
      let delivered: readonly (typeof a)[] = [];
      if (path === 'watch')
        await service.watch('billing', (list) => {
          delivered = list;
        });
      const deliver = async (list: readonly (typeof a)[]) => {
        if (path === 'watch') provider.emit('billing', list);
        else {
          provider.setInstances(list);
          await service.resolve('billing');
          await flush();
        }
      };
      await deliver([]);
      expect(await service.resolve('billing')).toEqual([]);
      await flush();
      await deliver([a]);
      await deliver([]);
      expect(await service.resolve('billing')).toEqual(grace === 0 ? [] : [a]);
      if (path === 'watch') expect(delivered).toEqual(grace === 0 ? [] : [a]);
      expect(service.degraded).toBe(grace > 0);
      expect(service.staleForMs).toBe(0);
      await flush();
      if (grace > 0) {
        runtime.advance(99);
        await deliver([a]);
        await deliver([]);
        runtime.advance(99);
        await deliver([]);
        expect(service.degraded).toBe(true);
        runtime.advance(1);
        await deliver([]);
        expect(await service.resolve('billing')).toEqual([]);
        expect(service.degraded).toBe(false);
      }
      service.close();
    });
  }
});
