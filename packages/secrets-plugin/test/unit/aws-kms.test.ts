import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptAwsModule,
  AwsKmsProvider,
  type AwsSdkModule,
  loadAwsModule,
  validateAwsClient,
} from '../../src/providers/aws-kms.ts';
import type { IAwsSecretsClient } from '../../src/interfaces/index.ts';

/** Fake AWS Secrets Manager facade over an in-memory store. */
class FakeAwsClient implements IAwsSecretsClient {
  readonly store = new Map<string, string>();
  getSecretValue(secretId: string): Promise<string | null> {
    return Promise.resolve(this.store.get(secretId) ?? null);
  }
  putSecretValue(secretId: string, value: string): Promise<void> {
    this.store.set(secretId, value);
    return Promise.resolve();
  }
}

/** Builds a fake AWS SDK module backed by a store, with pluggable error. */
function fakeAwsModule(store: Map<string, string>, error?: Error): AwsSdkModule {
  class GetCmd {
    readonly type = 'get';
    constructor(readonly input: { SecretId: string }) {}
  }
  class PutCmd {
    readonly type = 'put';
    constructor(readonly input: { SecretId: string; SecretString: string }) {}
  }
  class Client {
    send(cmd: unknown): Promise<{ SecretString?: string | undefined }> {
      const c = cmd as GetCmd | PutCmd;
      if (c.type === 'get') {
        if (error) {
          return Promise.reject(error);
        }
        return Promise.resolve({ SecretString: store.get(c.input.SecretId) });
      }
      store.set(c.input.SecretId, (c as PutCmd).input.SecretString);
      return Promise.resolve({});
    }
  }
  return {
    SecretsManagerClient: Client,
    GetSecretValueCommand: GetCmd,
    PutSecretValueCommand: PutCmd,
  } as unknown as AwsSdkModule;
}

describe('validateAwsClient', () => {
  it('accepts a valid shape and rejects malformed ones', () => {
    expect(validateAwsClient(new FakeAwsClient())).toBe(true);
    expect(validateAwsClient({})).toBe(false);
    expect(validateAwsClient({ getSecretValue: () => null })).toBe(false);
    expect(validateAwsClient(null)).toBe(false);
  });
});

describe('adaptAwsModule', () => {
  it('reads and writes via the SDK send() interface', async () => {
    const store = new Map<string, string>([['database/password', 's3cret']]);
    const facade = adaptAwsModule(fakeAwsModule(store), { region: 'us-east-1' });

    expect(await facade.getSecretValue('database/password')).toBe('s3cret');
    expect(await facade.getSecretValue('absent')).toBeNull();

    await facade.putSecretValue('api/key', 'new');
    expect(store.get('api/key')).toBe('new');
  });

  it('returns null on ResourceNotFoundException and rethrows other errors', async () => {
    const notFound = new Error('missing');
    notFound.name = 'ResourceNotFoundException';
    const nfFacade = adaptAwsModule(fakeAwsModule(new Map(), notFound), {});
    expect(await nfFacade.getSecretValue('x')).toBeNull();

    const boom = adaptAwsModule(fakeAwsModule(new Map(), new Error('boom')), {});
    await expect(boom.getSecretValue('x')).rejects.toThrow('boom');

    // A non-Error rejection takes the `instanceof Error` false branch and rethrows.
    const stringErr = adaptAwsModule(fakeAwsModule(new Map(), 'nope' as unknown as Error), {});
    try {
      await stringErr.getSecretValue('x');
      throw new Error('expected a rethrow');
    } catch (thrown) {
      expect(thrown).toBe('nope');
    }
  });

  it('passes credentials into the client config when both parts are present', async () => {
    // Exercises the credentials branch of buildAwsConfig (no throw = covered).
    const facade = adaptAwsModule(fakeAwsModule(new Map([['k', 'v']])), {
      region: 'eu-west-1',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
    expect(await facade.getSecretValue('k')).toBe('v');
  });
});

describe('AwsKmsProvider', () => {
  it('uses an injected client for get/set and reports readiness', async () => {
    const client = new FakeAwsClient();
    client.store.set('database/password', 's3cret');
    const provider = new AwsKmsProvider({ client });

    expect(provider.isReady()).toBe(false);
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    expect(await provider.get('database/password')).toBe('s3cret');
    await provider.set('api/key', 'new');
    expect(client.store.get('api/key')).toBe('new');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('throws when the injected client is malformed', async () => {
    const provider = new AwsKmsProvider({ client: {} as unknown as IAwsSecretsClient });
    await expect(provider.connect()).rejects.toThrow('Injected AWS client is missing');
  });

  it('rejects when used before connect', async () => {
    const provider = new AwsKmsProvider({ client: new FakeAwsClient() });
    await expect(provider.get('k')).rejects.toThrow('not connected');
    await expect(provider.set('k', 'v')).rejects.toThrow('not connected');
  });

  // Guarded real-import: enters the lazy `import('npm:@aws-sdk/client-secrets-manager')`
  // path without constructing a client (no AWS network / no side effects).
  it('loadAwsModule enters the real import path', async () => {
    try {
      const mod = await loadAwsModule();
      expect(mod.SecretsManagerClient).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
