import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAzureBlobClient } from '../../../src/interfaces/index.ts';
import { AzureBlobProvider } from '../../../src/providers/azure-provider.ts';

describe('AzureBlobProvider health (M70c)', () => {
  it('delegates to the client isHealthy when present (true)', async () => {
    let calls = 0;
    const client: IAzureBlobClient = {
      getContainerClient: () => ({}),
      isHealthy: () => {
        calls++;
        return Promise.resolve(true);
      },
    };
    const provider = new AzureBlobProvider({ containerName: 'c', client });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it('delegates to the client isHealthy when present (false)', async () => {
    const client: IAzureBlobClient = {
      getContainerClient: () => ({}),
      isHealthy: () => Promise.resolve(false),
    };
    const provider = new AzureBlobProvider({ containerName: 'c', client });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the client omits it', async () => {
    const client: IAzureBlobClient = { getContainerClient: () => ({}) };
    const provider = new AzureBlobProvider({ containerName: 'c', client });
    await provider.connect();
    // A minimal injected client has not told us the backend is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(provider.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const client: IAzureBlobClient = {
      getContainerClient: () => ({}),
      isHealthy: () => Promise.resolve(true),
    };
    const provider = new AzureBlobProvider({ containerName: 'c', client });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await provider.disconnect();
    expect(provider.isHealthy).toBeUndefined();
  });
});
