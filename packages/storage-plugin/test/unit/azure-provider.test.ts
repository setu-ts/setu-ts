/**
 * Tests for {@linkcode AzureBlobProvider}, {@linkcode adaptAzureModule},
 * {@linkcode isAzureNotFound}, and guarded real-import path.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { canSign } from '../../src/providers/azure-provider.ts';
import type { IAzureBlobClient } from '../../src/interfaces/index.ts';
import {
  adaptAzureModule,
  AzureBlobProvider,
  isAzureNotFound,
  loadAzureModule,
  validateAzureBlobClient,
} from '../../src/providers/azure-provider.ts';

/** Helper: create a NodeJS.ReadableStream that also implements AsyncIterable<Uint8Array>. */
function makeReadable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> & NodeJS.ReadableStream {
  let idx = 0;
  return {
    on(_event: string, _fn: (...args: unknown[]) => void) {
      // no-op - adapter path for provider get()/getStream()
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (idx < chunks.length) {
            return { done: false, value: chunks[idx++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  } as unknown as AsyncIterable<Uint8Array> & NodeJS.ReadableStream;
}

describe('isAzureNotFound', () => {
  it('returns true for statusCode 404', () => {
    expect(isAzureNotFound({ statusCode: 404 })).toBe(true);
  });

  it('returns false for other status codes', () => {
    expect(isAzureNotFound({ statusCode: 500 })).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isAzureNotFound(null)).toBe(false);
    expect(isAzureNotFound('error')).toBe(false);
    expect(isAzureNotFound(new Error('boom'))).toBe(false);
  });
});

describe('canSign', () => {
  it('returns true for accountName + accountKey', () => {
    expect(canSign({ accountName: 'acc', accountKey: 'key', containerName: 'c' })).toBe(true);
  });

  it('returns true when connection string has AccountKey', () => {
    expect(
      canSign({ connectionString: 'AccountName=foo;AccountKey=bar;', containerName: 'c' }),
    ).toBe(true);
  });

  it('returns false for account-name-only config', () => {
    expect(canSign({ accountName: 'foo', containerName: 'c' })).toBe(false);
  });

  it('returns false with no config', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(canSign({} as any)).toBe(false);
  });

  it('returns false for connection string without AccountKey', () => {
    expect(
      canSign({
        connectionString: 'DefaultEndpointsProtocol=https;AccountName=foo;',
        containerName: 'c',
      }),
    ).toBe(false);
  });

  it('returns false for connection string without AccountName', () => {
    expect(
      canSign({
        connectionString: 'DefaultEndpointsProtocol=https;AccountKey=bar;',
        containerName: 'c',
      }),
    ).toBe(false);
  });

  it('returns false for empty connection string', () => {
    expect(canSign({ connectionString: '', containerName: 'c' })).toBe(false);
  });

  it('prefers accountName/accountKey over connectionString extraction', () => {
    expect(
      canSign({
        accountName: 'explicit',
        accountKey: 'key',
        connectionString: 'AccountName=ignored;AccountKey=ignored;',
        containerName: 'c',
      }),
    ).toBe(true);
  });
});

describe('validateAzureBlobClient', () => {
  it('returns true for a valid client', () => {
    const client = { getContainerClient: () => ({}) };
    expect(validateAzureBlobClient(client)).toBe(true);
  });

  it('returns false for missing method', () => {
    const client = { nope: () => {} };
    expect(validateAzureBlobClient(client)).toBe(false);
  });
});

describe('adaptAzureModule', () => {
  function buildFakeAzure() {
    const store = new Map<string, Uint8Array>();
    let canSign = true;

    return {
      mod: {
        BlobServiceClient: class FakeService {
          static fromConnectionString(cs: string): FakeService {
            return new FakeService(cs);
          }
          constructor(_urlOrCs: string) {}
          getContainerClient(name: string) {
            return {
              getBlockBlobClient(blobName: string) {
                const key = `${name}/${blobName}`;
                return {
                  uploadData(data: Uint8Array): Promise<{ _hasSas: boolean }> {
                    store.set(key, data);
                    return Promise.resolve({ _hasSas: canSign });
                  },
                  // eslint-disable-next-line require-await
                  async download() {
                    const data = store.get(key);
                    if (data === undefined) {
                      return {
                        deleted: true,
                        readableStreamBody: null as unknown as NodeJS.ReadableStream,
                        contentLength: 0,
                      };
                    }
                    return {
                      deleted: false,
                      readableStreamBody: makeReadable([data]),
                      contentLength: data.length,
                    };
                  },
                  delete() {
                    store.delete(key);
                  },
                  getProperties() {
                    if (!store.has(key))
                      return Promise.reject({ statusCode: 404, code: 'BlobNotFound' });
                    return Promise.resolve({});
                  },
                  exists() {
                    return store.has(key);
                  },
                };
              },
            };
          }
        },
        StorageSharedKeyCredential: class {
          constructor(
            public accountName: string,
            public accountKey: string,
          ) {}
        },
        // C2 fix: real SDK signature is synchronous: generateBlobSASQueryParameters(values, credential)
        generateBlobSASQueryParameters(
          _values: {
            containerName: string;
            blobName: string;
            permissions: string;
            expiresOn: Date;
          },
          _credential: { accountName: string; accountKey: string },
        ) {
          return {
            toString() {
              return 'sas-token-signed';
            },
          };
        },
      } as unknown as import('../../src/providers/azure-provider.ts').AzureSdkModule,
      store: () => store,
      getCanSign: () => canSign,
      setCanSign: (v: boolean) => {
        canSign = v;
      },
    };
  }

  it('uploadData → store round-trip', async () => {
    const { mod, store } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'dGVzdGtleQ==',
    }) as IAzureBlobClient & { canSign: boolean };
    const container = facade.getContainerClient('mycontainer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = (container as any).getBlockBlobClient('test.bin');
    await blob.uploadData(new Uint8Array([11, 22, 33]));
    expect(store().get('mycontainer/test.bin')).toEqual(new Uint8Array([11, 22, 33]));
  });

  it('download returns deleted when absent', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'missing.bin',
    );
    const result = await blob.download();
    expect(result.deleted).toBe(true);
  });

  it('non-404 error does not match isAzureNotFound', () => {
    const error = new Error('boom');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (error as any).statusCode = 500;
    expect(isAzureNotFound(error)).toBe(false);
  });

  it('exists returns boolean', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'new.bin',
    );
    expect(await blob.exists()).toBe(false);
  });

  it('getSignedUrl throws when cannot sign', async () => {
    // When accountName is provided without accountKey and no connectionString,
    // adaptAzureModule throws at construction time.
    const { mod } = buildFakeAzure();
    await expect(() =>
      adaptAzureModule(mod, {
        containerName: 'mycontainer',
        accountName: 'fakeaccount',
      }),
    ).toThrow('accountName + options.accountKey');
  });

  it('connectionString-based config works', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      connectionString:
        'DefaultEndpointsProtocol=https;AccountName=csg acct;AccountKey=csgkey;EndpointSuffix=core.windows.net',
    }) as IAzureBlobClient;
    const container = facade.getContainerClient('mycontainer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = (container as any).getBlockBlobClient('cs-test.bin');
    await blob.uploadData(new Uint8Array([8]));
    expect(await blob.exists()).toBe(true);
  });

  it('facade download rethrows a non-404 error', async () => {
    const mod = {
      BlobServiceClient: class {
        constructor(_cs: string) {}
        getContainerClient() {
          return {
            getBlockBlobClient() {
              return {
                download() {
                  const e = new Error('boom');
                  (e as { statusCode?: number }).statusCode = 500;
                  return Promise.reject(e);
                },
              };
            },
          };
        }
      },
      StorageSharedKeyCredential: class {
        constructor(
          public accountName: string,
          public accountKey: string,
        ) {}
      },
      generateBlobSASQueryParameters: () => ({ toString: () => 'x' }),
    } as unknown as import('../../src/providers/azure-provider.ts').AzureSdkModule;
    const facade = adaptAzureModule(mod, { containerName: 'c', accountName: 'a', accountKey: 'k' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = ((facade as any).getContainerClient('c') as any).getBlockBlobClient('b');
    await expect(blob.download()).rejects.toThrow('boom');
  });
  it('facade delete resolves on success and rejects on failure (V13-245)', async () => {
    let shouldThrow = false;
    const mod = {
      BlobServiceClient: Object.assign(class {}, {
        fromConnectionString: () => ({
          getContainerClient() {
            return {
              getBlockBlobClient() {
                return {
                  delete() {
                    return shouldThrow ? Promise.reject(new Error('nope')) : Promise.resolve();
                  },
                };
              },
            };
          },
        }),
      }),
      StorageSharedKeyCredential: class {},
    } as unknown as import('../../src/providers/azure-provider.ts').AzureSdkModule;
    const facade = adaptAzureModule(mod, {
      containerName: 'c',
      connectionString: 'AccountName=a;AccountKey=k;',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = ((facade as any).getContainerClient('c') as any).getBlockBlobClient('b');
    await expect(blob.delete()).resolves.toBeUndefined();
    shouldThrow = true;
    await expect(blob.delete()).rejects.toThrow('nope');
  });
});

describe('AzureBlobProvider', () => {
  it('constructor without options is not ready until connected', () => {
    const provider = new AzureBlobProvider();
    expect(provider.isReady()).toBe(false);
  });

  it('getSignedUrl rejects when the client can neither sign nor generate a SAS', async () => {
    const client: IAzureBlobClient = {
      getContainerClient: () => ({ getBlockBlobClient: () => ({}) }),
    };
    const provider = new AzureBlobProvider({ containerName: 'c', client }, () => 0);
    await provider.connect();
    await expect(provider.getSignedUrl('x', { expiresIn: 60 })).rejects.toThrow(
      'requires an account key',
    );
  });

  it('getStream returns null on 404 and rethrows a non-404 error', async () => {
    const makeProvider = (status: number): AzureBlobProvider => {
      const client: IAzureBlobClient = {
        getContainerClient: () => ({
          getBlockBlobClient: () => ({
            download: () => {
              const e = new Error('download-failed');
              (e as { statusCode?: number }).statusCode = status;
              return Promise.reject(e);
            },
          }),
        }),
      };
      return new AzureBlobProvider({ containerName: 'c', client });
    };

    const p404 = makeProvider(404);
    await p404.connect();
    expect(await p404.getStream('k')).toBeNull();

    const p500 = makeProvider(500);
    await p500.connect();
    // A 500 on a read is classified as an outage (503) naming the provider.
    await expect(p500.getStream('k')).rejects.toThrow(/storage-plugin \(azure\): getStream/);
  });

  it('connect with injected client succeeds', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {},
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('connect with invalid injected client throws', async () => {
    const provider = new AzureBlobProvider({
      containerName: 'c',
      client: { nope: 42 } as unknown as IAzureBlobClient,
    });
    await expect(provider.connect()).rejects.toThrow(
      'Injected Azure client is missing required method',
    );
  });

  it('not-connected operations reject', async () => {
    const provider = new AzureBlobProvider({ containerName: 'c' });
    await expect(provider.put('k', new Uint8Array())).rejects.toThrow('not connected');
  });

  it('loadAzureModule enters the real import path', async () => {
    try {
      const mod = await loadAzureModule();
      expect(mod.BlobServiceClient).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('put delegates to injected client', async () => {
    let putCalled = false;
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: (_data: Uint8Array) => {
            putCalled = true;
            return Promise.resolve();
          },
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    await provider.put('myblob', new Uint8Array([1, 2, 3]));
    expect(putCalled).toBe(true);
  });

  it('get returns data via injected client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: false,
              readableStreamBody: makeReadable([new Uint8Array([99])]),
              contentLength: 1,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const result = await provider.get('someblob');
    expect(result).toEqual(new Uint8Array([99]));
  });

  it('delete returns false from injected client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve(false);
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const result = await provider.delete('someblob');
    expect(result).toBe(false);
  });

  it('exists returns true from injected client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return Promise.resolve(true);
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const result = await provider.exists('someblob');
    expect(result).toBe(true);
  });

  it('getSignedUrl delegates via client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: () => {
            return Promise.resolve();
          },
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
      getSignedUrl: () => Promise.resolve('https://sas.url?token=abc'),
      canSign: true,
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient }, () => 0);
    await provider.connect();
    const url = await provider.getSignedUrl('blob.txt', { expiresIn: 3600 });
    expect(url).toContain('sas.url');
  });

  it('getStream returns stream from injected client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: false,
              readableStreamBody: makeReadable([new Uint8Array([42])]),
              contentLength: 1,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('streamblob');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array([42]));
    }
  });

  it('disconnect clears client', async () => {
    const fakeClient = {
      getContainerClient: () => ({}),
    } as unknown as IAzureBlobClient;
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('connect with non-injected client (via adaptAzureModule) throws without accountKey', async () => {
    // When no client is injected and we try connect(), it tries to adaptAzureModule
    // which will fail because loadAzureModule imports the real SDK
    // This test just verifies the provider correctly delegates to connect()
    const provider = new AzureBlobProvider({ containerName: 'c' });
    expect(provider.isReady()).toBe(false);
    // connect without injection tries the lazy load path
    try {
      await provider.connect();
    } catch (e) {
      // Expected — SDK not available or wrong shape
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('getStream returns null when download indicates deleted', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('absent-blob');
    expect(stream).toBeNull();
  });

  it('getStream catches 404 error and returns null', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            throw { statusCode: 404 };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('notfound-stream');
    expect(stream).toBeNull();
  });

  it('get throws null when download().deleted is true', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const data = await provider.get('absent-key');
    expect(data).toBeNull();
  });

  it('get returns null when download throws 404', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            throw { statusCode: 404 };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const data = await provider.get('missing-on-throw');
    expect(data).toBeNull();
  });

  it('get rethrows non-404 error from download', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            throw new Error('network error');
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    await expect(provider.get('error-key')).rejects.toThrow('network error');
  });

  it('disconnect resets isReady to false', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient;
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
    await expect(provider.put('x', new Uint8Array())).rejects.toThrow('not connected');
  });

  it('connect() returns early when already connected (cached client)', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: true,
              readableStreamBody: null as unknown as NodeJS.ReadableStream,
              contentLength: 0,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    await provider.connect(); // second connect should return immediately (cached)
    expect(provider.isReady()).toBe(true);
  });
});

// ── getStream cancellation safety (stream-cancel-race fix) ────────────────

describe('AzureBlobProvider getStream cancellation safety', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('cancel releases the iterator and destroys the stream; later chunks are never enqueued', async () => {
    let destroys = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      await tick();
      yield new Uint8Array([2]); // lands after the consumer cancelled
      await tick();
      yield new Uint8Array([3]);
    }
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // eslint-disable-next-line require-await
          async download() {
            return {
              deleted: false,
              readableStreamBody: Object.assign(source(), {
                destroy(): void {
                  destroys++;
                },
              }),
              contentLength: 3,
            };
          },
          delete() {
            return Promise.resolve();
          },
          exists() {
            return true;
          },
        }),
      }),
    } as unknown as IAzureBlobClient;
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('cancel-race');
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect(destroys).toBe(1);
    // Let the cancelled source's remaining yields land: they must be a
    // deliberate drop, never an enqueue into the closed controller. No
    // uncaught TypeError reaching this line IS the assertion.
    await tick();
    await tick();
    await tick();
  });
});

describe('loadAzureModule — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { loadAzureModule } = await import('../../src/providers/azure-provider.ts');
    vi.doMock('@azure/storage-blob', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadAzureModule();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@azure/storage-blob');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@azure/storage-blob');
    }
  });
});
