import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type {
  IAzureBlobClient,
  IGcsClient,
  IS3Backend,
  StorageProvider,
} from '../../src/interfaces/index.ts';
import type { AzureOperationOptions, AzureSdkModule } from '../../src/providers/azure-provider.ts';
import {
  adaptAzureModule,
  AzureBlobProvider,
  buildAzureServiceClient,
  isAzureNotFound,
} from '../../src/providers/azure-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import { adaptGcsModule, GcsProvider } from '../../src/providers/gcs-provider.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module, S3Provider } from '../../src/providers/s3-provider.ts';
import { createProvider } from '../../src/plugin/storage-plugin.ts';
import { toStorageError } from '../../src/providers/fault.ts';

function azure(blob: object): AzureBlobProvider {
  return new AzureBlobProvider({
    containerName: 'c',
    requestTimeoutMs: 25,
    client: { getContainerClient: () => ({ getBlockBlobClient: () => blob }) },
  });
}

function gcs(file: object): GcsProvider {
  return new GcsProvider({
    bucket: 'b',
    requestTimeoutMs: 25,
    client: { bucket: () => ({ file: () => file }) },
  });
}

describe('Azure distinguishes blob misses from container faults', () => {
  for (const code of ['ContainerNotFound', 'BlobNotFound', undefined]) {
    it(`get/getStream/delete/exists with ${String(code)}`, async () => {
      const error = { statusCode: 404, details: { errorCode: code } };
      const reject = () => Promise.reject(error);
      const provider = azure({ download: reject, delete: reject, exists: reject });
      await provider.connect();
      for (const method of ['get', 'getStream', 'delete', 'exists'] as const) {
        if (code === 'ContainerNotFound') {
          await expect(provider[method]('k')).rejects.toMatchObject({ cause: error });
        } else {
          expect(await provider[method]('k')).toBe(method.startsWith('get') ? null : false);
        }
      }
    });
  }
  it('prefers details.errorCode, falls back to code and ignores non-404s', () => {
    expect(isAzureNotFound({ statusCode: 404, code: 'ContainerNotFound' })).toBe(false);
    expect(
      isAzureNotFound({
        statusCode: 404,
        code: 'ContainerNotFound',
        details: { errorCode: 'BlobNotFound' },
      }),
    ).toBe(true);
    expect(isAzureNotFound({ statusCode: 403, code: 'BlobNotFound' })).toBe(false);
    expect(isAzureNotFound(null)).toBe(false);
  });
  for (const code of ['ContainerNotFound', 'BlobNotFound', undefined]) {
    it(`adapted exists uses getProperties for ${String(code)}`, async () => {
      let seen: AbortSignal | undefined;
      const error = {
        statusCode: 404,
        ...(code === undefined ? {} : { details: { errorCode: code } }),
      };
      const mod = {
        BlobServiceClient: {
          fromConnectionString: () => ({
            getContainerClient: () => ({
              getBlockBlobClient: () => ({
                exists: () => Promise.resolve(false),
                getProperties: (opts: AzureOperationOptions) => {
                  seen = opts.abortSignal;
                  return Promise.reject(error);
                },
              }),
            }),
          }),
        },
      } as unknown as AzureSdkModule;
      const provider = new AzureBlobProvider({
        containerName: 'c',
        client: adaptAzureModule(mod, { containerName: 'c', connectionString: 'cs' }),
      });
      await provider.connect();
      if (code === 'ContainerNotFound')
        await expect(provider.exists('k')).rejects.toMatchObject({ cause: error });
      else expect(await provider.exists('k')).toBe(false);
      expect(seen).toBeInstanceOf(AbortSignal);
    });
  }
});

describe('an adapted Azure SDK client is aborted by the provider deadline', () => {
  it('hands the provider deadline signal to every SDK call', async () => {
    const seen: AbortSignal[] = [];
    const hang = (opts?: AzureOperationOptions): Promise<never> => {
      if (opts?.abortSignal !== undefined) seen.push(opts.abortSignal);
      return new Promise<never>(() => {});
    };
    const mod = {
      BlobServiceClient: {
        fromConnectionString: () => ({
          getContainerClient: () => ({
            getBlockBlobClient: () => ({
              uploadData: (_data: Uint8Array, opts?: AzureOperationOptions) => hang(opts),
              download: (_o?: number, _l?: number, opts?: AzureOperationOptions) => hang(opts),
              delete: (opts?: AzureOperationOptions) => hang(opts),
              exists: (opts?: AzureOperationOptions) => hang(opts),
              getProperties: (opts?: AzureOperationOptions) => hang(opts),
            }),
          }),
        }),
      },
    } as unknown as AzureSdkModule;
    // The adapter keeps its 30 s default; only the provider's 20 ms bound can
    // abort these calls, so each signal is aborted only if it is the provider's.
    const provider = new AzureBlobProvider({
      containerName: 'c',
      requestTimeoutMs: 20,
      client: adaptAzureModule(mod, { containerName: 'c', connectionString: 'cs' }),
    });
    await provider.connect();
    await expect(provider.put('k', new Uint8Array([1]))).rejects.toThrow();
    await expect(provider.get('k')).rejects.toThrow();
    await expect(provider.getStream('k')).rejects.toThrow();
    await expect(provider.delete('k')).rejects.toThrow();
    await expect(provider.exists('k')).rejects.toThrow();
    expect(seen).toHaveLength(5);
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });
  it('bounds a facade call made without a signal', async () => {
    let seen: AbortSignal | undefined;
    const mod = {
      BlobServiceClient: {
        fromConnectionString: () => ({
          getContainerClient: () => ({
            getBlockBlobClient: () => ({
              delete: (opts?: AzureOperationOptions) => {
                seen = opts?.abortSignal;
                return new Promise<never>(() => {});
              },
            }),
          }),
        }),
      },
    } as unknown as AzureSdkModule;
    const client = adaptAzureModule(
      mod,
      { containerName: 'c', connectionString: 'cs' },
      { timeoutMs: 20 },
    );
    const blob = (
      client.getContainerClient('c') as {
        getBlockBlobClient(name: string): { delete(): Promise<unknown> };
      }
    ).getBlockBlobClient('k');
    await expect(blob.delete()).rejects.toThrow(/did not answer within 20 ms/);
    expect(seen?.aborted).toBe(true);
  });
});

describe('an injected Azure SDK client keeps the container code on exists', () => {
  for (const code of ['ContainerNotFound', 'BlobNotFound']) {
    it(`exists through getProperties with ${code}`, async () => {
      const error = { statusCode: 404, details: { errorCode: code } };
      const provider = azure({
        exists: () => Promise.resolve(false),
        getProperties: () => Promise.reject(error),
      });
      await provider.connect();
      if (code === 'ContainerNotFound') {
        await expect(provider.exists('k')).rejects.toMatchObject({ cause: error });
      } else {
        expect(await provider.exists('k')).toBe(false);
      }
    });
  }
  it('answers true when getProperties resolves', async () => {
    const provider = azure({
      exists: () => Promise.resolve(false),
      getProperties: () => Promise.resolve({}),
    });
    await provider.connect();
    expect(await provider.exists('k')).toBe(true);
  });
});

describe('injected Azure operations receive the deadline signal', () => {
  for (const method of ['get', 'getStream', 'delete', 'exists', 'put'] as const) {
    it(method, async () => {
      let seen: AbortSignal | undefined;
      const wait = (options?: AzureOperationOptions): Promise<never> => {
        seen = options?.abortSignal;
        return new Promise(() => {});
      };
      const provider = azure({
        download: (_offset: unknown, _length: unknown, opts?: AzureOperationOptions) => wait(opts),
        delete: wait,
        exists: wait,
        uploadData: (_data: unknown, opts?: AzureOperationOptions) => wait(opts),
      });
      await provider.connect();
      const run = method === 'put' ? provider.put('k', new Uint8Array()) : provider[method]('k');
      await expect(run).rejects.toBeInstanceOf(
        method === 'put' || method === 'delete'
          ? BackendOutcomeUnknownError
          : BackendUnavailableError,
      );
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(true);
    });
  }
});

describe('Azure refuses unsupported download results', () => {
  for (const method of ['get', 'getStream'] as const) {
    it(method, async () => {
      let result: object = {};
      const provider = azure({ download: () => Promise.resolve(result) });
      await provider.connect();
      await expect(provider[method]('k')).rejects.toThrow(
        /AzureBlobProvider: unsupported download result/,
      );
      result = { readableStreamBody: null };
      await expect(provider[method]('k')).rejects.toThrow(
        /AzureBlobProvider: unsupported download result/,
      );
    });
  }
});

describe('GCS local ENOENT is a fault', () => {
  it('rejects from every missing-object path', async () => {
    const error = { code: 'ENOENT' };
    const reject = () => Promise.reject(error);
    const provider = gcs({
      download: reject,
      getMetadata: reject,
      delete: reject,
      createReadStream: () => {
        throw error;
      },
    });
    await provider.connect();
    for (const method of ['get', 'getStream', 'delete', 'exists'] as const) {
      await expect(provider[method]('k')).rejects.toMatchObject({ cause: error });
    }
  });
});

describe('GCS refuses endpoint beside STORAGE_EMULATOR_HOST', () => {
  const runtime = (host?: string): IRuntimeServices =>
    ({
      now: () => 0,
      hrtime: () => 0,
      setTimeout,
      clearTimeout,
      env: host === undefined ? {} : { STORAGE_EMULATOR_HOST: host },
    }) as unknown as IRuntimeServices;
  const make = (endpoint: string | undefined, host?: string, injected = false): StorageProvider =>
    createProvider(
      {
        provider: 'gcs',
        options: {
          bucket: 'b',
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(injected ? { client: { bucket: () => ({}) } } : {}),
        },
      },
      runtime(host),
    );
  it('refuses both at construction, even when they name the same host', () => {
    for (const [endpoint, host] of [
      ['http://one.test', 'http://two.test'],
      ['http://one.test', 'http://one.test'],
      ['http://one.test', 'http://one.test/storage/v1'],
    ] as const) {
      expect(() => make(endpoint, host)).toThrow(/either endpoint or STORAGE_EMULATOR_HOST/);
    }
  });
  it('accepts either one alone, an empty variable, and any pair beside an injected client', () => {
    expect(() => make('http://one.test')).not.toThrow();
    expect(() => make(undefined, 'http://one.test')).not.toThrow();
    expect(() => make('http://one.test', '')).not.toThrow();
    expect(() => make('http://one.test', 'http://two.test', true)).not.toThrow();
  });
  it('refuses a direct endpoint with no environment, and accepts one beside a client', () => {
    expect(() => new GcsProvider({ bucket: 'b', endpoint: 'http://one.test' })).toThrow(
      /endpoint needs the runtime environment/,
    );
    expect(
      () =>
        new GcsProvider({
          bucket: 'b',
          endpoint: 'http://one.test',
          client: { bucket: () => ({}) } as unknown as IGcsClient,
        }),
    ).not.toThrow();
    expect(() => new GcsProvider({ bucket: 'b' })).not.toThrow();
  });
  it('rechecks the environment on connect', async () => {
    const env: Record<string, string | undefined> = {};
    const provider = new GcsProvider(
      { bucket: 'b', endpoint: 'http://one.test' },
      undefined,
      undefined,
      env,
    );
    env.STORAGE_EMULATOR_HOST = 'http://two.test';
    await expect(provider.connect()).rejects.toBeInstanceOf(RangeError);
  });
});

describe('buffered GCS download releases its stream at the deadline', () => {
  it('passes the signal through the facade and destroys the source', async () => {
    const source = new Readable({
      read() {
        this.push(new Uint8Array([1]));
        this._read = () => {};
      },
    });
    const destroy = vi.spyOn(source, 'destroy');
    const mod = {
      Storage: class {
        bucket() {
          return {
            file: () => ({ createReadStream: () => source, download: () => new Promise(() => {}) }),
          };
        }
      },
    } as unknown as GcsSdkModule;
    const provider = new GcsProvider({
      bucket: 'b',
      requestTimeoutMs: 25,
      client: adaptGcsModule(mod, { bucket: 'b' }),
    });
    await provider.connect();
    await expect(provider.get('k')).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(destroy).toHaveBeenCalled();
    expect(source.destroyed).toBe(true);
  });
});

describe('GCS peer floor', () => {
  it('requires upload authentication support in peer and dev ranges', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(manifest.peerDependencies['@google-cloud/storage']).toBe('^7.18.0');
    expect(manifest.devDependencies['@google-cloud/storage']).toBe('^7.18.0');
  });
});

describe('GCS failed first read releases an iterator without awaiting return', () => {
  it('returns promptly even when return never settles', async () => {
    const error = new Error('first read');
    const release = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}));
    const provider = gcs({
      createReadStream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error), return: release }),
      }),
    });
    await provider.connect();
    const started = performance.now();
    await expect(provider.getStream('k')).rejects.toMatchObject({ cause: error });
    expect(release).toHaveBeenCalledOnce();
    expect(performance.now() - started).toBeLessThan(200);
  });
  it('handles a rejected iterator return without losing the first-read error', async () => {
    const error = new Error('read refused');
    const release = vi.fn(() => Promise.reject(new Error('return refused')));
    const provider = gcs({
      createReadStream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error), return: release }),
      }),
    });
    await provider.connect();
    await expect(provider.getStream('k')).rejects.toMatchObject({ cause: error });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('a synchronous iterator teardown throw keeps the first-read answer', () => {
  it('reads a 404 first read as absent', async () => {
    const provider = gcs({
      createReadStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(Object.assign(new Error('gone'), { code: 404 })),
          return: () => {
            throw new Error('teardown failed');
          },
        }),
      }),
    });
    await provider.connect();
    expect(await provider.getStream('k')).toBeNull();
  });
});

describe('a GCS source whose destroy() throws keeps the first-read answer', () => {
  it('reads a 404 first read as absent', async () => {
    const provider = gcs({
      createReadStream: () => ({
        destroy: () => {
          throw new Error('destroy failed');
        },
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(Object.assign(new Error('gone'), { code: 404 })),
        }),
      }),
    });
    await provider.connect();
    expect(await provider.getStream('k')).toBeNull();
  });
});

describe('the Azure SDK client makes one attempt per call', () => {
  it('passes maxTries 1 for both connection forms', () => {
    const seen: unknown[] = [];
    const client = { getContainerClient: () => ({}) };
    const mod = {
      BlobServiceClient: Object.assign(
        class {
          constructor(_url: string, _credential: unknown, options: unknown) {
            seen.push(options);
            return client;
          }
        },
        {
          fromConnectionString: (_cs: string, options: unknown) => {
            seen.push(options);
            return client;
          },
        },
      ),
      StorageSharedKeyCredential: class {},
    } as unknown as AzureSdkModule;
    buildAzureServiceClient(mod, { containerName: 'c', connectionString: 'cs' });
    buildAzureServiceClient(mod, { containerName: 'c', accountName: 'a', accountKey: 'k' });
    expect(seen).toEqual([{ retryOptions: { maxTries: 1 } }, { retryOptions: { maxTries: 1 } }]);
  });
});

describe('write outcomes after an SDK retried', () => {
  const s3Rejecting = (error: unknown): S3Provider =>
    new S3Provider({
      bucket: 'b',
      client: {
        put: () => Promise.reject(error),
        get: () => Promise.reject(error),
        delete: () => Promise.reject(error),
        head: () => Promise.reject(error),
        getSignedUrl: () => Promise.reject(error),
        getStream: () => Promise.reject(error),
      } as unknown as IS3Backend,
    });
  it('a 503 after retries is outcome-unknown for a write, unavailable for a read', async () => {
    const error = Object.assign(new Error('Slow Down'), {
      $metadata: { httpStatusCode: 503, attempts: 3 },
    });
    const provider = s3Rejecting(error);
    await provider.connect();
    await expect(provider.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(
      BackendOutcomeUnknownError,
    );
    await expect(provider.get('k')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
  it('a 503 on a single attempt stays unavailable for a write', async () => {
    const error = Object.assign(new Error('Slow Down'), {
      $metadata: { httpStatusCode: 503, attempts: 1 },
    });
    const provider = s3Rejecting(error);
    await provider.connect();
    await expect(provider.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });
  it('a rejection with no text form keeps its value as the cause', async () => {
    const error: unknown = Object.create(null);
    const provider = s3Rejecting(error);
    await provider.connect();
    const failure = (await provider.get('k').catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/a value with no text form/);
    expect(failure.cause).toBe(error);
  });
});

describe('a write refusal with no recorded attempt count', () => {
  const refused = (): unknown =>
    Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
  it('is outcome-unknown from a client that may retry on its own', () => {
    expect(toStorageError(refused(), 'azure', 'put')).toBeInstanceOf(BackendOutcomeUnknownError);
  });
  it('stays unavailable from a client the provider built with its retry off', () => {
    expect(toStorageError(refused(), 'azure', 'put', true)).toBeInstanceOf(BackendUnavailableError);
  });
  it('is unavailable for a read either way', () => {
    expect(toStorageError(refused(), 'azure', 'get')).toBeInstanceOf(BackendUnavailableError);
  });
});

describe('an Azure client with its own signer needs no clock', () => {
  it('signs through the client without now', async () => {
    const provider = new AzureBlobProvider({
      containerName: 'c',
      client: {
        getContainerClient: () => ({ getBlockBlobClient: () => ({}) }),
        getSignedUrl: (path: string, expiresIn: number) =>
          Promise.resolve(`https://signed.test/${path}?e=${expiresIn}`),
      } as unknown as IAzureBlobClient,
    });
    await provider.connect();
    expect(await provider.getSignedUrl('k', { expiresIn: 60 })).toBe('https://signed.test/k?e=60');
  });
  it('still refuses the SDK signing path without now', async () => {
    const provider = new AzureBlobProvider({
      containerName: 'c',
      client: {
        getContainerClient: () => ({ getBlockBlobClient: () => ({}) }),
      } as unknown as IAzureBlobClient,
    });
    await provider.connect();
    await expect(provider.getSignedUrl('k', { expiresIn: 60 })).rejects.toThrow(/needs a clock/);
  });
});

describe('S3 distinguishes object misses from bucket errors', () => {
  for (const shape of ['plain', 'Error']) {
    for (const name of ['NoSuchBucket', 'NoSuchKey', 'NotFound', undefined]) {
      it(`${shape} ${String(name)}`, async () => {
        const fields = {
          ...(name === undefined ? {} : { name }),
          $metadata: { httpStatusCode: 404 },
        };
        const error = shape === 'plain' ? fields : Object.assign(new Error('S3 error'), fields);
        if (shape === 'Error' && name === undefined)
          Object.defineProperty(error, 'name', { value: undefined });
        const command = class {};
        const mod = {
          s3: {
            S3Client: class {
              send() {
                return Promise.reject(error);
              }
            },
            PutObjectCommand: command,
            GetObjectCommand: command,
            HeadObjectCommand: command,
            DeleteObjectCommand: command,
          },
          presigner: { getSignedUrl: () => Promise.resolve('') },
        } as unknown as AwsStorageSdkModule;
        const provider = new S3Provider({
          bucket: 'b',
          client: adaptAwsS3Module(mod, { bucket: 'b' }),
        });
        await provider.connect();
        for (const method of ['get', 'getStream'] as const) {
          if (name === 'NoSuchBucket')
            await expect(provider[method]('k')).rejects.toMatchObject({ cause: error });
          else expect(await provider[method]('k')).toBeNull();
        }
      });
    }
  }
});

describe('injected S3 writes and HEAD receive the deadline signal', () => {
  for (const method of ['put', 'delete', 'exists'] as const) {
    it(method, async () => {
      let seen: AbortSignal | undefined;
      const wait = (signal?: AbortSignal): Promise<never> => {
        seen = signal;
        return new Promise(() => {});
      };
      const backend: IS3Backend = {
        put: (_path, _data, _options, signal) => wait(signal),
        delete: (_path, signal) => wait(signal),
        head: (_path, signal) => (method === 'delete' ? Promise.resolve(true) : wait(signal)),
        get: () => Promise.resolve(null),
        getStream: () => Promise.resolve(null),
        getSignedUrl: () => Promise.resolve(''),
      };
      const provider = new S3Provider({ bucket: 'b', client: backend, requestTimeoutMs: 25 });
      await provider.connect();
      const run = method === 'put' ? provider.put('k', new Uint8Array()) : provider[method]('k');
      await expect(run).rejects.toBeInstanceOf(
        method === 'exists' ? BackendUnavailableError : BackendOutcomeUnknownError,
      );
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(true);
    });
  }
});
