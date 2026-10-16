import { describe, expect, it } from 'vitest';
import type { IDiscoveryHttp } from '../../src/interfaces/index.ts';
import { KubernetesProvider } from '../../src/providers/kubernetes-provider.ts';
import { ConsulProvider } from '../../src/providers/consul-provider.ts';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions } from '../../src/options.ts';
import { createFakeRuntime } from '../fixtures/fakes.ts';

describe('real provider probe method binding', () => {
  it.each(['kubernetes', 'consul'] as const)(
    '%s retains its private-field receiver',
    async (kind) => {
      const calls: string[] = [];
      const http: IDiscoveryHttp = {
        request: (url) => {
          calls.push(url);
          return Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: '{}' });
        },
        stream: () => Promise.reject(new Error('unused stream')),
      };
      const runtime = createFakeRuntime();
      const provider =
        kind === 'kubernetes'
          ? new KubernetesProvider(
              { namespace: 'default', apiServer: 'https://kube.test', token: 'test-token' },
              http,
              runtime,
            )
          : new ConsulProvider({ address: 'https://consul.test', waitSeconds: 10 }, http, runtime);
      const service = new ServiceDiscoveryService(
        provider,
        runtime,
        resolveOptions({ provider: 'static', services: {} }),
      );
      expect(await service.isHealthy()).toBe(true);
      expect(calls).toEqual([
        kind === 'kubernetes'
          ? 'https://kube.test/apis/discovery.k8s.io/v1/namespaces/default/endpointslices?limit=1'
          : 'https://consul.test/v1/status/leader',
      ]);
    },
  );
});
