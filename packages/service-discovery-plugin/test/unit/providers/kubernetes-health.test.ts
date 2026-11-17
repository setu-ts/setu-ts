import { describe, expect, it } from 'vitest';
import { KubernetesProvider } from '../../../src/providers/kubernetes-provider.ts';
import { createFakeHttp, createFakeRuntime } from '../../fixtures/fakes.ts';

const OPTIONS = {
  namespace: 'default',
  apiServer: 'https://10.0.0.1:6443',
  token: 'tok',
};

describe('KubernetesProvider health (M70c)', () => {
  it('is reachable when the EndpointSlice LIST answers 2xx', async () => {
    const http = createFakeHttp([{ status: 200, text: '{"items":[]}' }]);
    const provider = new KubernetesProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(true);
    // The probe is a limit=1 LIST against the EndpointSlice API.
    expect(http.calls[0]?.url).toContain(
      '/apis/discovery.k8s.io/v1/namespaces/default/endpointslices?limit=1',
    );
  });

  it('rejects with the status when the API answers non-2xx (M139f X10-3)', async () => {
    const http = createFakeHttp([{ status: 403, text: 'forbidden' }]);
    const provider = new KubernetesProvider(OPTIONS, http, createFakeRuntime());
    await expect(provider.isHealthy()).rejects.toThrow(
      new Error('Kubernetes EndpointSlice probe failed with HTTP 403'),
    );
  });

  it('rejects with the original TLS error X10-3 observed, not a bare false', async () => {
    // An in-cluster API server whose CA plain fetch rejects: the transport
    // throws, and the probe hands that exact error on so the service can log
    // the cause instead of swallowing it.
    const tls = new Error('UnknownIssuer');
    const http = createFakeHttp([{ error: tls }]);
    const provider = new KubernetesProvider(OPTIONS, http, createFakeRuntime());
    await expect(provider.isHealthy()).rejects.toBe(tls);
  });
});
