import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISesClient } from '../../../src/interfaces/index.ts';
import { SesProvider } from '../../../src/providers/ses-provider.ts';

function makeClient(isHealthy?: () => Promise<boolean>): ISesClient {
  const client: Record<string, unknown> = {
    sendEmail: () => Promise.resolve(),
  };
  if (isHealthy !== undefined) {
    client.isHealthy = isHealthy;
  }
  return client as unknown as ISesClient;
}

describe('SesProvider health (M70c)', () => {
  it('delegates to the client isHealthy when present (true)', async () => {
    let calls = 0;
    const provider = new SesProvider({
      client: makeClient(() => {
        calls++;
        return Promise.resolve(true);
      }),
    });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it('delegates to the client isHealthy when present (false)', async () => {
    const provider = new SesProvider({ client: makeClient(() => Promise.resolve(false)) });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the client omits it', async () => {
    const provider = new SesProvider({ client: makeClient() });
    await provider.connect();
    // A minimal injected client has not told us the account is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(provider.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const provider = new SesProvider({ client: makeClient(() => Promise.resolve(true)) });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await provider.disconnect();
    expect(provider.isHealthy).toBeUndefined();
  });
});
