/**
 * The GCS and Azure arms start from their documented options and sign
 * correctly (V13-233, V13-234, V13-248), GCS streams honour "absent" before
 * answering (V13-235), and the new readiness probes follow the "answered"
 * rule (V13-215, lane half).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '@setu-ts/common';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import {
  adaptGcsModule,
  buildGcsConfig,
  GcsProvider,
  isGcsNotFound,
} from '../../src/providers/gcs-provider.ts';
import type { AzureSdkModule } from '../../src/providers/azure-provider.ts';
import {
  adaptAzureModule,
  AzureBlobProvider,
  buildAzureServiceClient,
} from '../../src/providers/azure-provider.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module } from '../../src/providers/s3-provider.ts';
import type { IGcsClient } from '../../src/interfaces/index.ts';

const NOW = 1_795_000_000_000;

describe('buildGcsConfig (V13-235, V13-248)', () => {
  it('turns the SDK retry off and passes only what is set', () => {
    expect(buildGcsConfig({ bucket: 'b' })).toEqual({ retryOptions: { autoRetry: false } });
    expect(buildGcsConfig({ bucket: 'b', projectId: 'p' })).toEqual({
      retryOptions: { autoRetry: false },
      projectId: 'p',
    });
  });

  it('sends credentials to a custom endpoint unless endpointAuth is false', () => {
    for (const [endpointAuth, expected] of [
      [undefined, true],
      [true, true],
      [false, false],
    ] as const) {
      expect(
        buildGcsConfig({ bucket: 'b', endpoint: 'http://127.0.0.1:4443', endpointAuth }),
      ).toEqual({
        retryOptions: { autoRetry: false },
        apiEndpoint: 'http://127.0.0.1:4443',
        useAuthWithCustomEndpoint: expected,
      });
    }
  });

  it('adaptGcsModule hands the config to the SDK constructor', () => {
    let seen: Record<string, unknown> | undefined;
    const mod = {
      Storage: class {
        constructor(config: Record<string, unknown>) {
          seen = config;
        }
        bucket(): unknown {
          return {};
        }
      },
    } as unknown as GcsSdkModule;
    adaptGcsModule(mod, { bucket: 'b', endpoint: 'http://e', requestTimeoutMs: 0 });
    expect(seen).toMatchObject({ apiEndpoint: 'http://e', useAuthWithCustomEndpoint: true });
  });
});

/** A GCS client whose file returns the given handle. */
function gcsClient(file: Record<string, unknown>, probe?: () => Promise<boolean>): IGcsClient {
  return {
    bucket: () => ({ file: () => file }),
    ...(probe === undefined ? {} : { isHealthy: probe }),
  } as IGcsClient;
}

describe('GcsProvider.getSignedUrl (V13-234)', () => {
  it('passes an epoch-millisecond expiry in the future', async () => {
    let expires = 0;
    const provider = new GcsProvider(
      {
        bucket: 'b',
        client: gcsClient({
          getSignedUrl: (config: { expires: number }) => {
            expires = config.expires;
            return Promise.resolve(['https://signed']);
          },
        }),
      },
      () => NOW,
    );
    await provider.connect();
    expect(await provider.getSignedUrl('k', { expiresIn: 300 })).toBe('https://signed');
    expect(expires).toBe(NOW + 300_000);
  });

  it('refuses by name when constructed without a clock', async () => {
    const provider = new GcsProvider({ bucket: 'b', client: gcsClient({}) });
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(/needs a clock/);
  });
});

/** An async-iterable read stream whose first `next()` does what `first` says. */
function readStream(
  first: 'data' | 'end' | Error,
  rest: Uint8Array[] = [],
): AsyncIterable<Uint8Array> & { destroyed: boolean; destroy(): void } {
  const chunks = first === 'data' ? [new Uint8Array([1, 2]), ...rest] : [];
  const stream = {
    destroyed: false,
    destroy(): void {
      stream.destroyed = true;
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (first instanceof Error) return Promise.reject(first);
          const value = chunks[index++];
          return Promise.resolve(
            value === undefined ? { done: true, value: undefined } : { done: false, value },
          );
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return stream;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream) out.push(...chunk);
  return out;
}

describe('GcsProvider.getStream waits for the first chunk (V13-235)', () => {
  it('an absent object is null and the source is released', async () => {
    const source = readStream(Object.assign(new Error('No such object'), { code: 404 }));
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    expect(await provider.getStream('k')).toBeNull();
    expect(source.destroyed).toBe(true);
  });

  it('a refused credential rejects before any answer, naming the provider', async () => {
    const source = readStream(Object.assign(new Error('Forbidden'), { code: 403 }));
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    await expect(provider.getStream('k')).rejects.toThrow(
      /^storage-plugin \(gcs\): getStream failed: Forbidden/,
    );
  });

  it('an outage is a 503', async () => {
    const source = readStream(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    await expect(provider.getStream('k')).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('streams the first chunk and the rest; an empty object is an empty stream', async () => {
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => readStream('data', [new Uint8Array([3])]) }),
    });
    await provider.connect();
    expect(await readAll((await provider.getStream('k'))!)).toEqual([1, 2, 3]);
    const empty = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => readStream('end') }),
    });
    await empty.connect();
    expect(await readAll((await empty.getStream('k'))!)).toEqual([]);
  });

  it('cancel destroys the source', async () => {
    const source = readStream('data', [new Uint8Array([3])]);
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    const stream = (await provider.getStream('k'))!;
    await stream.cancel();
    expect(source.destroyed).toBe(true);
  });

  it('an error after the first chunk errors the stream and releases the source', async () => {
    let calls = 0;
    const source = {
      destroyed: false,
      destroy(): void {
        source.destroyed = true;
      },
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Uint8Array>> =>
          calls++ === 0
            ? Promise.resolve({ done: false, value: new Uint8Array([9]) })
            : Promise.reject(new Error('reset')),
      }),
    };
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    await expect(readAll((await provider.getStream('k'))!)).rejects.toThrow('reset');
    expect(source.destroyed).toBe(true);
  });

  it('a synchronous createReadStream throw is classified', async () => {
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({
        createReadStream: () => {
          throw Object.assign(new Error('gone'), { code: 404 });
        },
      }),
    });
    await provider.connect();
    expect(await provider.getStream('k')).toBeNull();
    const failing = new GcsProvider({
      bucket: 'b',
      client: gcsClient({
        createReadStream: () => {
          throw new Error('boom');
        },
      }),
    });
    await failing.connect();
    await expect(failing.getStream('k')).rejects.toThrow(/storage-plugin \(gcs\)/);
  });

  it('a string chunk and an array-like chunk become bytes', async () => {
    const chunks: unknown[] = ['ab', [3]];
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          const value = chunks.shift();
          return Promise.resolve(
            value === undefined ? { done: true, value: undefined } : { done: false, value },
          );
        },
      }),
    };
    const provider = new GcsProvider({
      bucket: 'b',
      client: gcsClient({ createReadStream: () => source }),
    });
    await provider.connect();
    expect(await readAll((await provider.getStream('k'))!)).toEqual([97, 98, 3]);
  });
});

describe('isGcsNotFound', () => {
  it('reads the numeric code only, never the message', () => {
    expect(isGcsNotFound({ code: 404 })).toBe(true);
    expect(isGcsNotFound({ code: 'ENOENT' })).toBe(true);
    expect(isGcsNotFound(new Error('Not Found'))).toBe(false);
    expect(isGcsNotFound({ code: 403, message: 'Not Found' })).toBe(false);
    expect(isGcsNotFound(null)).toBe(false);
  });
});

describe('GCS readiness probe: answered = reachable (V13-215)', () => {
  function probeWith(exists: () => Promise<[boolean]>): Promise<boolean> {
    const mod = {
      Storage: class {
        bucket(): unknown {
          return { exists };
        }
      },
    } as unknown as GcsSdkModule;
    return adaptGcsModule(mod, { bucket: 'b', requestTimeoutMs: 200 }).isHealthy!();
  }

  for (const [name, exists, expected] of [
    ['bucket exists', () => Promise.resolve([true] as [boolean]), true],
    ['bucket missing', () => Promise.resolve([false] as [boolean]), true],
    [
      'credential refused (403)',
      () => Promise.reject(Object.assign(new Error(), { code: 403 })),
      true,
    ],
    ['backend 503', () => Promise.reject(Object.assign(new Error(), { code: 503 })), false],
    [
      'connection refused',
      () => Promise.reject(Object.assign(new Error(), { code: 'ECONNREFUSED' })),
      false,
    ],
    ['never answers', () => new Promise<[boolean]>(() => undefined), false],
  ] as const) {
    it(`${name} → ${expected}`, async () => {
      expect(await probeWith(exists as () => Promise<[boolean]>)).toBe(expected);
    });
  }

  it('a provider over a client with a probe installs it; without one it stays unknown', async () => {
    const withProbe = new GcsProvider({
      bucket: 'b',
      client: gcsClient({}, () => Promise.resolve(true)),
    });
    await withProbe.connect();
    expect(await withProbe.isHealthy!()).toBe(true);
    await withProbe.disconnect();
    expect(withProbe.isHealthy).toBeUndefined();
    const without = new GcsProvider({ bucket: 'b', client: gcsClient({}) });
    await without.connect();
    expect(without.isHealthy).toBeUndefined();
  });
});

/** A fake Azure SDK module recording how the service client was built. */
function azureModule(blob: Record<string, unknown>, containerExists?: () => Promise<boolean>) {
  const built: { from?: string; url?: string; credential?: unknown } = {};
  const service = {
    getContainerClient: () => ({
      getBlockBlobClient: () => blob,
      exists: containerExists ?? (() => Promise.resolve(true)),
    }),
  };
  const mod = {
    BlobServiceClient: Object.assign(
      class {
        constructor(url: string, credential?: unknown) {
          built.url = url;
          built.credential = credential;
          return service;
        }
      },
      {
        fromConnectionString: (cs: string) => {
          built.from = cs;
          return service;
        },
      },
    ),
    StorageSharedKeyCredential: class {
      constructor(
        readonly name: string,
        readonly key: string,
      ) {}
    },
  } as unknown as AzureSdkModule;
  return { mod, built };
}

describe('buildAzureServiceClient (V13-233)', () => {
  it('reads a connection string through fromConnectionString', () => {
    const { mod, built } = azureModule({});
    buildAzureServiceClient(mod, {
      containerName: 'c',
      connectionString: 'UseDevelopmentStorage=true',
    });
    expect(built.from).toBe('UseDevelopmentStorage=true');
    expect(built.url).toBeUndefined();
  });

  it('the key form defaults to the public host and takes an endpoint', () => {
    const one = azureModule({});
    buildAzureServiceClient(one.mod, {
      containerName: 'c',
      accountName: 'acct',
      accountKey: 'a2V5',
    });
    expect(one.built.url).toBe('https://acct.blob.core.windows.net');
    expect(one.built.credential).toMatchObject({ name: 'acct', key: 'a2V5' });
    const two = azureModule({});
    buildAzureServiceClient(two.mod, {
      containerName: 'c',
      accountName: 'acct',
      accountKey: 'a2V5',
      endpoint: 'http://127.0.0.1:10000/acct',
    });
    expect(two.built.url).toBe('http://127.0.0.1:10000/acct');
  });

  it('refuses options with neither form', () => {
    const { mod } = azureModule({});
    expect(() => buildAzureServiceClient(mod, { containerName: 'c' })).toThrow(
      /requires either options.connectionString/,
    );
  });
});

describe('AzureBlobProvider with an injected SDK-shaped client (V13-233)', () => {
  /** A class instance, as the SDK's clients are: its methods live on the prototype. */
  class FakeBlob {
    readonly uploads: Uint8Array[] = [];
    uploadData(data: Uint8Array): Promise<unknown> {
      this.uploads.push(data);
      return Promise.resolve({});
    }
    exists(): Promise<boolean> {
      return Promise.resolve(true);
    }
    delete(): Promise<unknown> {
      return Promise.resolve({ requestId: 'r' });
    }
    generateSasUrl(options: { permissions: string; expiresOn: Date }): Promise<string> {
      return Promise.resolve(
        `https://acct.blob.core.windows.net/c/a%20b?se=${options.expiresOn.getTime()}&sp=${options.permissions}`,
      );
    }
  }
  class FakeService {
    readonly blob = new FakeBlob();
    getContainerClient(): unknown {
      return { getBlockBlobClient: () => this.blob };
    }
  }

  it('keeps the client intact, so its prototype methods work', async () => {
    const service = new FakeService();
    const provider = new AzureBlobProvider({ containerName: 'c', client: service }, () => NOW);
    await provider.connect();
    await provider.put('k', new Uint8Array([1]));
    expect(service.blob.uploads).toHaveLength(1);
    expect(await provider.exists('k')).toBe(true);
    expect(await provider.delete('k')).toBe(true);
  });

  it('signs through generateSasUrl with read permission and an epoch-ms expiry', async () => {
    const provider = new AzureBlobProvider(
      { containerName: 'c', client: new FakeService() },
      () => NOW,
    );
    await provider.connect();
    expect(await provider.getSignedUrl('a b', { expiresIn: 60 })).toBe(
      `https://acct.blob.core.windows.net/c/a%20b?se=${NOW + 60_000}&sp=r`,
    );
  });

  it("maps the SDK's no-shared-key RangeError to the account-key refusal", async () => {
    const service = new FakeService();
    service.blob.generateSasUrl = () =>
      Promise.reject(
        new RangeError(
          'Can only generate the SAS when the client is initialized with a shared key credential',
        ),
      );
    const provider = new AzureBlobProvider({ containerName: 'c', client: service }, () => NOW);
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(
      /requires an account key/,
    );
  });

  it('refuses when the blob client cannot sign at all, and passes other errors through', async () => {
    const bare = {
      getContainerClient: () => ({ getBlockBlobClient: () => ({}) }),
    };
    const provider = new AzureBlobProvider({ containerName: 'c', client: bare }, () => NOW);
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(
      /requires an account key/,
    );
    const service = new FakeService();
    service.blob.generateSasUrl = () => Promise.reject(new Error('odd'));
    const other = new AzureBlobProvider({ containerName: 'c', client: service }, () => NOW);
    await other.connect();
    await expect(other.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(/odd/);
  });

  it("uses an injected facade's own getSignedUrl when it has one", async () => {
    const provider = new AzureBlobProvider(
      {
        containerName: 'c',
        client: {
          getContainerClient: () => ({}),
          getSignedUrl: (path: string, expiresIn: number) =>
            Promise.resolve(`facade:${path}:${expiresIn}`),
        },
      },
      () => NOW,
    );
    await provider.connect();
    expect(await provider.getSignedUrl('k', { expiresIn: 9 })).toBe('facade:k:9');
  });

  it('refuses to sign without a clock', async () => {
    const provider = new AzureBlobProvider({ containerName: 'c', client: new FakeService() });
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(/needs a clock/);
  });
});

describe('the adapted Azure client (V13-216, V13-215)', () => {
  it('hands every operation the bound signal, and signs through generateSasUrl', async () => {
    const signals: unknown[] = [];
    const record = (options?: { abortSignal?: AbortSignal }) => {
      signals.push(options?.abortSignal);
      return Promise.resolve({});
    };
    const blob = {
      uploadData: (_d: Uint8Array, options?: { abortSignal?: AbortSignal }) => record(options),
      download: (_o?: number, _l?: number, options?: { abortSignal?: AbortSignal }) =>
        record(options),
      delete: record,
      exists: (options?: { abortSignal?: AbortSignal }) => record(options).then(() => true),
      generateSasUrl: (o: { permissions: string }) => Promise.resolve(`sas:${o.permissions}`),
    };
    const { mod } = azureModule(blob);
    const client = adaptAzureModule(mod, {
      containerName: 'c',
      connectionString: 'UseDevelopmentStorage=true',
      requestTimeoutMs: 5000,
    });
    const provider = new AzureBlobProvider({ containerName: 'c', client }, () => NOW);
    await provider.connect();
    await provider.put('k', new Uint8Array([1]), { contentType: 'text/plain' });
    expect(await provider.get('k')).toBeNull();
    await provider.delete('k');
    await provider.exists('k');
    expect(signals).toHaveLength(4);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    expect(await provider.getSignedUrl('k', { expiresIn: 1 })).toBe('sas:r');
  });

  it('an adapted blob without generateSasUrl refuses to sign', async () => {
    const { mod } = azureModule({});
    const client = adaptAzureModule(mod, { containerName: 'c', connectionString: 'x' });
    const provider = new AzureBlobProvider({ containerName: 'c', client }, () => NOW);
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 1 })).rejects.toThrow(
      /requires an account key/,
    );
  });

  for (const [name, exists, expected] of [
    ['container exists', () => Promise.resolve(true), true],
    [
      'credential refused (403)',
      () => Promise.reject(Object.assign(new Error(), { statusCode: 403 })),
      true,
    ],
    ['backend 503', () => Promise.reject(Object.assign(new Error(), { statusCode: 503 })), false],
    [
      'connection refused',
      () => Promise.reject(Object.assign(new Error(), { code: 'ECONNREFUSED' })),
      false,
    ],
  ] as const) {
    it(`probe: ${name} → ${expected}`, async () => {
      const { mod } = azureModule({}, exists as () => Promise<boolean>);
      const client = adaptAzureModule(mod, { containerName: 'c', connectionString: 'x' });
      expect(await client.isHealthy!()).toBe(expected);
    });
  }
});

describe('the adapted S3 client', () => {
  it('hands every SDK call the bound signal and reads a bare 404 as not-found', async () => {
    const signals: unknown[] = [];
    const mod = {
      s3: {
        S3Client: class {
          send(_command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
            signals.push(options?.abortSignal);
            return Promise.reject(
              Object.assign(new Error('404'), { $metadata: { httpStatusCode: 404 } }),
            );
          }
        },
        PutObjectCommand: class {},
        GetObjectCommand: class {},
        DeleteObjectCommand: class {},
        HeadObjectCommand: class {},
      },
      presigner: { getSignedUrl: () => Promise.resolve('https://presigned') },
    } as unknown as AwsStorageSdkModule;
    const client = adaptAwsS3Module(mod, { bucket: 'b' });
    expect(await client.head('k')).toBe(false);
    expect(await client.get('k')).toBeNull();
    expect(await client.getSignedUrl('k', 60)).toBe('https://presigned');
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
