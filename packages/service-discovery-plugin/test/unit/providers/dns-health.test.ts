import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DnsProvider } from '../../../src/providers/dns-provider.ts';
import type { DiscoveryProvider } from '../../../src/interfaces/index.ts';
import { createFakeRuntime } from '../../fixtures/fakes.ts';

describe('DnsProvider health (M70c)', () => {
  it('omits isHealthy — DNS has no configured service name to probe', () => {
    const resolver = {
      resolveHost: () => Promise.resolve(['10.0.0.1']),
      resolveSrv: () => Promise.resolve([]),
    };
    const provider = new DnsProvider(
      resolver as never,
      createFakeRuntime(),
      { domainTemplate: '{service}.svc', mode: 'a', port: 80, watchIntervalMs: 1000 },
    );
    // Absence is *unknown* reachability, not `false`: the indicator falls back
    // on `everResolved`/`degraded` instead of claiming the backend is dead.
    expect((provider as DiscoveryProvider).isHealthy).toBeUndefined();
  });
});
