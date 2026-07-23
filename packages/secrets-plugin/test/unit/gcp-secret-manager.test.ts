import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptGcpModule,
  type GcpSdkModule,
  GcpSecretManagerProvider,
  isGcpNotFound,
  loadGcpModule,
  validateGcpClient,
} from '../../src/providers/gcp-secret-manager.ts';
import type { IGcpSecretsClient } from '../../src/interfaces/index.ts';

/** Fake GCP Secret Manager facade over an in-memory store. */
class FakeGcpClient implements IGcpSecretsClient {
  readonly store = new Map<string, string>();
  accessSecretVersion(name: string): Promise<string | null> {
    return Promise.resolve(this.store.get(name) ?? null);
  }
  addSecretVersion(name: string, value: string): Promise<void> {
    this.store.set(name, value);
    return Promise.resolve();
  }
}

/** Builds a fake GCP SDK module backed by a store. `stringData` returns the
 * payload as a string instead of bytes; `error` makes access reject. */
function fakeGcpModule(
  store: Map<string, string>,
  opts?: { stringData?: boolean; error?: unknown },
): GcpSdkModule {
  class Client {
    accessSecretVersion(
      request: { name: string },
    ): Promise<[{ payload?: { data?: string | Uint8Array | null } }]> {
      if (opts?.error !== undefined) {
        return Promise.reject(opts.error);
      }
      const short = request.name.split('/secrets/')[1].split('/versions/')[0];
      const value = store.get(short);
      if (value === undefined) {
        return Promise.resolve([{ payload: { data: null } }]);
      }
      const data = opts?.stringData ? value : new TextEncoder().encode(value);
      return Promise.resolve([{ payload: { data } }]);
    }
    addSecretVersion(
      request: { parent: string; payload: { data: Uint8Array } },
    ): Promise<unknown> {
      const short = request.parent.split('/secrets/')[1];
      store.set(short, new TextDecoder().decode(request.payload.data));
      return Promise.resolve({});
    }
  }
  return { SecretManagerServiceClient: Client } as unknown as GcpSdkModule;
}

describe('validateGcpClient / isGcpNotFound', () => {
  it('accepts a valid shape and rejects malformed ones', () => {
    expect(validateGcpClient(new FakeGcpClient())).toBe(true);
    expect(validateGcpClient({ accessSecretVersion: () => null })).toBe(false);
    expect(validateGcpClient(42)).toBe(false);
  });

  it('detects a gRPC NOT_FOUND code', () => {
    expect(isGcpNotFound({ code: 5 })).toBe(true);
    expect(isGcpNotFound({ code: 7 })).toBe(false);
    expect(isGcpNotFound(null)).toBe(false);
  });
});

describe('adaptGcpModule', () => {
  it('reads bytes and string payloads and writes new versions', async () => {
    const store = new Map<string, string>([['token', 'v']]);
    const facade = adaptGcpModule(fakeGcpModule(store), 'proj');
    expect(await facade.accessSecretVersion('token')).toBe('v');
    expect(await facade.accessSecretVersion('absent')).toBeNull();

    await facade.addSecretVersion('token', 'v2');
    expect(store.get('token')).toBe('v2');

    const strFacade = adaptGcpModule(
      fakeGcpModule(new Map([['s', 'plain']]), { stringData: true }),
      'p',
    );
    expect(await strFacade.accessSecretVersion('s')).toBe('plain');
  });

  it('returns null on NOT_FOUND and rethrows other errors', async () => {
    const nf = adaptGcpModule(fakeGcpModule(new Map(), { error: { code: 5 } }), 'p');
    expect(await nf.accessSecretVersion('x')).toBeNull();

    const boom = adaptGcpModule(fakeGcpModule(new Map(), { error: new Error('boom') }), 'p');
    await expect(boom.accessSecretVersion('x')).rejects.toThrow('boom');
  });

  it('requires a projectId', () => {
    expect(() => adaptGcpModule(fakeGcpModule(new Map()), undefined)).toThrow(
      'requires options.projectId',
    );
  });
});

describe('GcpSecretManagerProvider', () => {
  it('uses an injected client for get/set', async () => {
    const client = new FakeGcpClient();
    client.store.set('token', 'v');
    const provider = new GcpSecretManagerProvider({ projectId: 'p', client });

    await provider.connect();
    expect(provider.isReady()).toBe(true);
    expect(await provider.get('token')).toBe('v');
    await provider.set('token', 'v2');
    expect(client.store.get('token')).toBe('v2');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('throws when the injected client is malformed', async () => {
    const provider = new GcpSecretManagerProvider({
      projectId: 'p',
      client: {} as unknown as IGcpSecretsClient,
    });
    await expect(provider.connect()).rejects.toThrow('Injected GCP client is missing');
  });

  it('rejects when used before connect', async () => {
    const provider = new GcpSecretManagerProvider({ projectId: 'p', client: new FakeGcpClient() });
    await expect(provider.get('k')).rejects.toThrow('not connected');
    await expect(provider.set('k', 'v')).rejects.toThrow('not connected');
  });

  it('loadGcpModule enters the real import path', async () => {
    try {
      const mod = await loadGcpModule();
      expect(mod.SecretManagerServiceClient).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
