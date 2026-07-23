import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptAzureModule,
  AzureKeyVaultProvider,
  type AzureSdkModule,
  isAzureNotFound,
  loadAzureModule,
  validateAzureClient,
} from '../../src/providers/azure-key-vault.ts';
import type { IAzureSecretsClient } from '../../src/interfaces/index.ts';

/** Fake Azure Key Vault facade over an in-memory store. */
class FakeAzureClient implements IAzureSecretsClient {
  readonly store = new Map<string, string>();
  getSecret(name: string): Promise<string | null> {
    return Promise.resolve(this.store.get(name) ?? null);
  }
  setSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
    return Promise.resolve();
  }
}

/** Builds a fake Azure SDK module backed by a store. */
function fakeAzureModule(store: Map<string, string>, error?: unknown): AzureSdkModule {
  class Credential {}
  class Client {
    constructor(readonly url: string, readonly cred: object) {}
    getSecret(name: string): Promise<{ value?: string | undefined }> {
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve({ value: store.get(name) });
    }
    setSecret(name: string, value: string): Promise<unknown> {
      store.set(name, value);
      return Promise.resolve({});
    }
  }
  return {
    SecretClient: Client,
    DefaultAzureCredential: Credential,
  } as unknown as AzureSdkModule;
}

describe('validateAzureClient / isAzureNotFound', () => {
  it('accepts a valid shape and rejects malformed ones', () => {
    expect(validateAzureClient(new FakeAzureClient())).toBe(true);
    expect(validateAzureClient({ getSecret: () => null })).toBe(false);
    expect(validateAzureClient(undefined)).toBe(false);
  });

  it('detects an HTTP 404', () => {
    expect(isAzureNotFound({ statusCode: 404 })).toBe(true);
    expect(isAzureNotFound({ statusCode: 500 })).toBe(false);
    expect(isAzureNotFound('x')).toBe(false);
  });
});

describe('adaptAzureModule', () => {
  it('reads and writes via the SDK client', async () => {
    const store = new Map<string, string>([['db-password', 'v']]);
    const facade = adaptAzureModule(fakeAzureModule(store), 'https://x.vault.azure.net');
    expect(await facade.getSecret('db-password')).toBe('v');
    expect(await facade.getSecret('absent')).toBeNull();

    await facade.setSecret('db-password', 'v2');
    expect(store.get('db-password')).toBe('v2');
  });

  it('returns null on 404 and rethrows other errors', async () => {
    const nf = adaptAzureModule(fakeAzureModule(new Map(), { statusCode: 404 }), 'https://x');
    expect(await nf.getSecret('x')).toBeNull();

    const boom = adaptAzureModule(fakeAzureModule(new Map(), new Error('boom')), 'https://x');
    await expect(boom.getSecret('x')).rejects.toThrow('boom');
  });

  it('requires a vaultUrl', () => {
    expect(() => adaptAzureModule(fakeAzureModule(new Map()), undefined)).toThrow(
      'requires options.vaultUrl',
    );
  });
});

describe('AzureKeyVaultProvider', () => {
  it('uses an injected client for get/set', async () => {
    const client = new FakeAzureClient();
    client.store.set('db-password', 'v');
    const provider = new AzureKeyVaultProvider({ vaultUrl: 'https://x.vault.azure.net', client });

    await provider.connect();
    expect(provider.isReady()).toBe(true);
    expect(await provider.get('db-password')).toBe('v');
    await provider.set('db-password', 'v2');
    expect(client.store.get('db-password')).toBe('v2');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('throws when the injected client is malformed', async () => {
    const provider = new AzureKeyVaultProvider({
      vaultUrl: 'https://x.vault.azure.net',
      client: {} as unknown as IAzureSecretsClient,
    });
    await expect(provider.connect()).rejects.toThrow('Injected Azure client is missing');
  });

  it('rejects when used before connect', async () => {
    const provider = new AzureKeyVaultProvider({ client: new FakeAzureClient() });
    await expect(provider.get('k')).rejects.toThrow('not connected');
    await expect(provider.set('k', 'v')).rejects.toThrow('not connected');
  });

  it('loadAzureModule enters the real import path', async () => {
    try {
      const mod = await loadAzureModule();
      expect(mod.SecretClient).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
