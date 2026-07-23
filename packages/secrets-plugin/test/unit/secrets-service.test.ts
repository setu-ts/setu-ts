import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { SecretsService } from '../../src/services/secrets-service.ts';
import type { SecretProvider } from '../../src/interfaces/index.ts';

/** A fake provider recording calls and serving a mutable in-memory store. */
class FakeProvider implements SecretProvider {
  readonly store = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  isReady(): boolean {
    return true;
  }
  get(name: string): Promise<string | null> {
    this.getCalls++;
    return Promise.resolve(this.store.get(name) ?? null);
  }
  set(name: string, value: string): Promise<void> {
    this.setCalls++;
    this.store.set(name, value);
    return Promise.resolve();
  }
}

describe('SecretsService', () => {
  it('get returns the provider value and throws when absent', async () => {
    const provider = new FakeProvider();
    provider.store.set('database/password', 's3cret');
    const service = new SecretsService(provider);

    expect(await service.get('database/password')).toBe('s3cret');
    await expect(service.get('missing')).rejects.toThrow('Secret not found: missing');
  });

  it('caches reads: a second get within TTL does not hit the provider', async () => {
    const provider = new FakeProvider();
    provider.store.set('k', 'v');
    let now = 1000;
    const service = new SecretsService(provider, { cacheTtlSeconds: 60, clock: () => now });

    expect(await service.get('k')).toBe('v');
    expect(await service.get('k')).toBe('v');
    expect(provider.getCalls).toBe(1);

    // Advance past the TTL → re-fetch.
    now += 60_001;
    expect(await service.get('k')).toBe('v');
    expect(provider.getCalls).toBe(2);
  });

  it('cacheTtl 0 disables caching', async () => {
    const provider = new FakeProvider();
    provider.store.set('k', 'v');
    const service = new SecretsService(provider, { cacheTtlSeconds: 0 });

    await service.get('k');
    await service.get('k');
    expect(provider.getCalls).toBe(2);
  });

  it('has returns true/false and caches a present secret', async () => {
    const provider = new FakeProvider();
    provider.store.set('present', 'x');
    let now = 0;
    const service = new SecretsService(provider, { cacheTtlSeconds: 60, clock: () => now });

    expect(await service.has('present')).toBe(true);
    expect(await service.has('absent')).toBe(false);

    // The present secret is now cached: has short-circuits, get does not re-fetch.
    now += 1;
    expect(await service.has('present')).toBe(true);
    expect(await service.get('present')).toBe('x');
    expect(provider.getCalls).toBe(2); // present(miss→cache) + absent(miss); cached reads add 0
  });

  it('rotate writes through the provider and updates the cache', async () => {
    const provider = new FakeProvider();
    provider.store.set('k', 'old');
    let now = 0;
    const service = new SecretsService(provider, { cacheTtlSeconds: 60, clock: () => now });

    // Prime the cache with the old value.
    expect(await service.get('k')).toBe('old');

    await service.rotate('k', 'new');
    expect(provider.setCalls).toBe(1);
    expect(provider.store.get('k')).toBe('new');

    // Subsequent get serves the rotated value from cache without re-fetching.
    now += 1;
    expect(await service.get('k')).toBe('new');
    expect(provider.getCalls).toBe(1);
  });
});
