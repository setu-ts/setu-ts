import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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

  it('is unreachable when the API answers non-2xx', async () => {
    const http = createFakeHttp([{ status: 403, text: 'forbidden' }]);
    const provider = new KubernetesProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable on the TLS rejection shape X10-3 observed', async () => {
    // An in-cluster API server whose CA plain fetch rejects: the transport
    // throws, and the probe must surface that as `down`, not swallow it.
    const http = createFakeHttp([{ error: new Error('UnknownIssuer') }]);
    const provider = new KubernetesProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });
});
