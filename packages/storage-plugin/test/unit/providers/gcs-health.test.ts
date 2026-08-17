import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IGcsClient } from '../../../src/interfaces/index.ts';
import { GcsProvider } from '../../../src/providers/gcs-provider.ts';

describe('GcsProvider health (M70c)', () => {
  it('delegates to the client isHealthy when present (true)', async () => {
    let calls = 0;
    const client: IGcsClient = {
      bucket: () => ({}),
      isHealthy: () => {
        calls++;
        return Promise.resolve(true);
      },
    };
    const provider = new GcsProvider({ bucket: 'b', client });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it('delegates to the client isHealthy when present (false)', async () => {
    const client: IGcsClient = {
      bucket: () => ({}),
      isHealthy: () => Promise.resolve(false),
    };
    const provider = new GcsProvider({ bucket: 'b', client });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the client omits it', async () => {
    const client: IGcsClient = { bucket: () => ({}) };
    const provider = new GcsProvider({ bucket: 'b', client });
    await provider.connect();
    // A minimal injected client has not told us the backend is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(provider.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const client: IGcsClient = {
      bucket: () => ({}),
      isHealthy: () => Promise.resolve(true),
    };
    const provider = new GcsProvider({ bucket: 'b', client });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await provider.disconnect();
    expect(provider.isHealthy).toBeUndefined();
  });
});
