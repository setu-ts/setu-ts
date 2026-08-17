import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConsulProvider } from '../../../src/providers/consul-provider.ts';
import { createFakeHttp, createFakeRuntime } from '../../fixtures/fakes.ts';

const OPTIONS = { address: 'http://127.0.0.1:8500', waitSeconds: 5 };

describe('ConsulProvider health (M70c)', () => {
  it('is reachable when /v1/status/leader answers 2xx', async () => {
    const http = createFakeHttp([{ status: 200, text: '127.0.0.1:8300' }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(true);
    // The probe hits the leader endpoint, not a health read.
    expect(http.calls[0]?.url).toBe('http://127.0.0.1:8500/v1/status/leader');
  });

  it('is unreachable when the agent answers non-2xx', async () => {
    const http = createFakeHttp([{ status: 500, text: 'boom' }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable on a transport failure', async () => {
    const http = createFakeHttp([{ error: new Error('ECONNREFUSED') }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });
});
