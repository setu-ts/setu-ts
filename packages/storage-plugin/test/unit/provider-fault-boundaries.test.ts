import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { IS3Backend, StorageProvider } from '../../src/interfaces/index.ts';
import type { AzureOperationOptions, AzureSdkModule } from '../../src/providers/azure-provider.ts';
import {
  adaptAzureModule,
  AzureBlobProvider,
  isAzureNotFound,
} from '../../src/providers/azure-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import { adaptGcsModule, GcsProvider } from '../../src/providers/gcs-provider.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module, S3Provider } from '../../src/providers/s3-provider.ts';
import { createProvider } from '../../src/plugin/storage-plugin.ts';

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

describe('GCS refuses split endpoints through runtime.env', () => {
  const runtime = (host?: string): IRuntimeServices =>
    ({
      now: () => 0,
      hrtime: () => 0,
      setTimeout,
      clearTimeout,
      env: host === undefined ? {} : { STORAGE_EMULATOR_HOST: host },
    }) as unknown as IRuntimeServices;
  const make = (endpoint: string, host?: string): StorageProvider =>
    createProvider(
      { provider: 'gcs', options: { bucket: 'b', endpoint, client: { bucket: () => ({}) } } },
      runtime(host),
    );
  it('different env and endpoint refuse at construction', () => {
    expect(() => make('http://one.test', 'http://two.test')).toThrow(
      /endpoint.*STORAGE_EMULATOR_HOST/,
    );
  });
  it('equal, scheme-less and trailing-slash variants are accepted', async () => {
    for (const [endpoint, host] of [
      ['http://one.test/', 'http://one.test'],
      ['one.test/', 'https://one.test/'],
      ['http://one.test', undefined],
    ] as const) {
      const provider = make(endpoint, host);
      await provider.connect();
      expect(provider.isReady()).toBe(true);
    }
  });
  it('rechecks the environment on connect', async () => {
    const env = { STORAGE_EMULATOR_HOST: 'https://one.test' };
    const provider = new GcsProvider(
      { bucket: 'b', endpoint: 'one.test', client: { bucket: () => ({}) } },
      undefined,
      undefined,
      env,
    );
    env.STORAGE_EMULATOR_HOST = 'https://two.test';
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
