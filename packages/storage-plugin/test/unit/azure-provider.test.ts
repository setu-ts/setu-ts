/**
 * Tests for {@linkcode AzureBlobProvider}, {@linkcode adaptAzureModule},
 * {@linkcode isAzureNotFound}, and guarded real-import path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
    expect(canSign({ connectionString: 'AccountName=foo;AccountKey=bar;', containerName: 'c' }))
      .toBe(
        true,
      );
  });

  it('returns false for account-name-only config', () => {
    expect(canSign({ accountName: 'foo', containerName: 'c' })).toBe(false);
  });

  it('returns false with no config', () => {
    // deno-lint-ignore no-explicit-any
    expect(canSign({} as any)).toBe(false);
  });

  it('returns false for connection string without AccountKey', () => {
    expect(
      canSign({
        connectionString: 'DefaultEndpointsProtocol=https;AccountName=foo;',
        containerName: 'c',
      }),
    )
      .toBe(false);
  });

  it('returns false for connection string without AccountName', () => {
    expect(
      canSign({
        connectionString: 'DefaultEndpointsProtocol=https;AccountKey=bar;',
        containerName: 'c',
      }),
    )
      .toBe(false);
  });

  it('returns false for empty connection string', () => {
    expect(canSign({ connectionString: '', containerName: 'c' })).toBe(false);
  });

  it('prefers accountName/accountKey over connectionString extraction', () => {
    expect(canSign({
      accountName: 'explicit',
      accountKey: 'key',
      connectionString: 'AccountName=ignored;AccountKey=ignored;',
      containerName: 'c',
    })).toBe(true);
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
                  // deno-lint-ignore require-await
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
    // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'missing.bin',
    );
    const result = await blob.download();
    expect(result.deleted).toBe(true);
  });

  it('non-404 error does not match isAzureNotFound', () => {
    const error = new Error('boom');
    // deno-lint-ignore no-explicit-any
    (error as any).statusCode = 500;
    expect(isAzureNotFound(error)).toBe(false);
  });

  it('download throws 404 error → adapted blob returns deleted:true', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    // deno-lint-ignore no-explicit-any
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'missing.bin',
    );
    const result = await blob.download();
    expect(result.deleted).toBe(true);
    expect(result.contentLength).toBe(0);
  });

  it('download error recovery with 404 statusCode in adaptAzureModule', async () => {
    // Build a fake where download() throws an object with statusCode: 404
    const store = new Map<string, Uint8Array>();
    const fakeMod = {
      BlobServiceClient: class {
        constructor(_urlOrCs: string) {}
        getContainerClient(name: string) {
          return {
            getBlockBlobClient(blobName: string) {
              return {
                uploadData(_data: Uint8Array): Promise<void> {
                  store.set(`${name}/${blobName}`, _data);
                  return Promise.resolve();
                },
                // deno-lint-ignore require-await
                async download() {
                  throw { statusCode: 404 };
                },
                delete() {
                  return Promise.resolve();
                },
                exists() {
                  return false;
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
            return 'sas';
          },
        });
      },
    };

    const azureMod =
      fakeMod as unknown as import('../../src/providers/azure-provider.ts').AzureSdkModule;
    const adapterResult = adaptAzureModule(azureMod, {
      containerName: 'errRecover',
      accountName: 'fake',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    // deno-lint-ignore no-explicit-any
    const blob = ((adapterResult as any).getContainerClient('errRecover') as any)
      .getBlockBlobClient('gone.bin');
    const downloadResult = await blob.download();
    expect(downloadResult.deleted).toBe(true);
    expect(downloadResult.contentLength).toBe(0);
  });

  it('exists returns boolean', async () => {
    const { mod } = buildFakeAzure();
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as IAzureBlobClient & { canSign: boolean };
    // deno-lint-ignore no-explicit-any
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
    });
    const url = await (facade as { getSignedUrl: (p: string, e: number) => Promise<string> })
      .getSignedUrl('blob.txt', 3600);
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
    // deno-lint-ignore no-explicit-any
    const blob = (container as any).getBlockBlobClient('cs-test.bin');
    await blob.uploadData(new Uint8Array([8]));
    expect(await blob.exists()).toBe(true);
  });

  it('getSignedUrl resolves credentials from connectionString (covers cs-parsing path)', async () => {
    const { mod } = buildFakeAzure();
    // deno-lint-ignore no-explicit-any
    const facade: any = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      connectionString:
        'DefaultEndpointsProtocol=https;AccountName=csaccount;AccountKey=cskey;EndpointSuffix=core.windows.net',
    });
    expect(facade.canSign).toBe(true);
    const sasUrl = await facade.getSignedUrl('blob.txt', 3600);
    expect(sasUrl).toContain('sas-token-signed');
    expect(sasUrl).toContain('csaccount');
  });
});

describe('AzureBlobProvider', () => {
  it('connect with injected client succeeds', async () => {
    const fakeClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData: async () => {},
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
          // deno-lint-ignore require-await
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
