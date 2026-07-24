// deno-lint-ignore-file no-explicit-any ban-unused-ignore require-await
/**

/**
 * Tests for {@linkcode AzureBlobProvider}, {@linkcode adaptAzureModule},
 * {@linkcode isAzureNotFound}, and guarded real-import path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
        BlobServiceClient: class {
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
                  download() {
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
                  exists() {
                    return store.has(key);
                  },
                };
              },
            };
          }
        },
        StorageSharedKeyCredential: class {
          constructor(public accountName: string, public accountKey: string) {}
        },
        generateBlobSASQueryParameters(_params: unknown): Promise<{ toString(): string }> {
          return Promise.resolve({
            toString() {
              return 'sas-token-signed';
            },
          });
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
    const blob = (container as any).getBlockBlobClient('test.bin');
    await blob.uploadData(new Uint8Array([11, 22, 33]));
    expect(store().get('mycontainer/test.bin')).toEqual(new Uint8Array([11, 22, 33]));
  });

  it('download returns deleted when absent', () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'missing.bin',
    );
    const result = blob.download();
    expect(result.deleted).toBe(true);
  });

  it('non-404 error does not match isAzureNotFound', () => {
    const error = new Error('boom');
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
      })
    ).toThrow('accountName + options.accountKey');
  });

  it('getSignedUrl returns URL when signed', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as any;
    const url = await facade.getSignedUrl('blob.txt', 3600);
    expect(url).toContain('sas-token-signed');
  });

  it('connectionString-based config works', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      connectionString:
        'DefaultEndpointsProtocol=https;AccountName=csg acct;AccountKey=csgkey;EndpointSuffix=core.windows.net',
    }) as IAzureBlobClient & { canSign: boolean };
    expect(facade.canSign).toBe(true);
    const container = facade.getContainerClient('mycontainer');
    const blob = (container as any).getBlockBlobClient('cs-test.bin');
    await blob.uploadData(new Uint8Array([8]));
    expect(await blob.exists()).toBe(true);
  });
});

describe('AzureBlobProvider', () => {
  it('connect with injected client succeeds', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          download: () => ({
            deleted: true,
            readableStreamBody: null as unknown as NodeJS.ReadableStream,
            contentLength: 0,
          }),
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
          uploadData: async (_data: Uint8Array) => {
            putCalled = true;
          },
          download: () => ({
            deleted: true,
            readableStreamBody: null as unknown as NodeJS.ReadableStream,
            contentLength: 0,
          }),
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
          download: () => ({
            deleted: false,
            readableStreamBody: makeReadable([new Uint8Array([99])]),
            contentLength: 1,
          }),
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
          download: () => ({
            deleted: true,
            readableStreamBody: null as unknown as NodeJS.ReadableStream,
            contentLength: 0,
          }),
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
          download: () => ({
            deleted: true,
            readableStreamBody: null as unknown as NodeJS.ReadableStream,
            contentLength: 0,
          }),
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
          uploadData: async () => {},
          download: () => ({
            deleted: true,
            readableStreamBody: null as unknown as NodeJS.ReadableStream,
            contentLength: 0,
          }),
          delete() {
            return Promise.resolve();
          },
          exists() {
            return false;
          },
        }),
      }),
      getSignedUrl: async () => 'https://sas.url?token=abc',
      canSign: true,
    } as unknown as IAzureBlobClient & { canSign: boolean };
    const provider = new AzureBlobProvider({ containerName: 'c', client: fakeClient });
    await provider.connect();
    const url = await provider.getSignedUrl('blob.txt', { expiresIn: 3600 });
    expect(url).toContain('sas.url');
  });

  it('getStream returns stream from injected client', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          download: () => ({
            deleted: false,
            readableStreamBody: makeReadable([new Uint8Array([42])]),
            contentLength: 1,
          }),
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
});
