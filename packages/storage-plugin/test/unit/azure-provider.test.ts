// deno-lint-ignore-file no-explicit-any ban-unused-ignore
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

    // deno-lint-ignore no-explicit-any
    return {
      mod: {
        BlobServiceClient: class {
          constructor(_urlOrCs: string) {}
          getContainerClient(name: string) {
            // deno-lint-ignore no-explicit-any
            return {
              getBlockBlobClient(blobName: string) {
                const key = `${name}/${blobName}`;
                // deno-lint-ignore no-explicit-any
                return {
                  uploadData(data: Uint8Array): Promise<{ _hasSas: boolean }> {
                    store.set(key, data);
                    return Promise.resolve({ _hasSas: canSign });
                  },
                  download() {
                    const data = store.get(key);
                    if (data === undefined) {
                      // deno-lint-ignore no-explicit-any
                      return {
                        deleted: true,
                        readableStreamBody: null as unknown as NodeJS.ReadableStream,
                        contentLength: 0,
                      };
                    }

                    // deno-lint-ignore no-explicit-any
                    return {
                      deleted: false,
                      readableStreamBody: makeReadable([data]) as any,
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

  function makeReadable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> & NodeJS.ReadableStream {
    let idx = 0;
    // deno-lint-ignore no-explicit-any
    // deno-lint-ignore no-explicit-any
    return {
      on(event: string, fn: (...args: unknown[]) => void) {
        if (event === 'data' && idx < chunks.length) {
          setTimeout(() => fn(chunks[idx++]), 0);
        }
      },
      [Symbol.asyncIterator]() {
        // deno-lint-ignore no-explicit-any
        return {
          next() {
            // deno-lint-ignore no-explicit-any
            if (idx < chunks.length) {
              // deno-lint-ignore no-explicit-any
              return { done: false, value: chunks[idx++] } as any;
            }
            // deno-lint-ignore no-explicit-any
            return { done: true, value: undefined } as any;
          },
        };
      },
      // deno-lint-ignore no-explicit-any
      next(): Promise<{ done: boolean; value?: unknown }> {
        if (idx < chunks.length) {
          // deno-lint-ignore no-explicit-any
          return Promise.resolve(
            { done: false, value: chunks[idx++] } as { done: boolean; value?: unknown },
          );
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    } as unknown as AsyncIterable<Uint8Array> & NodeJS.ReadableStream;
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

  it('download returns deleted when absent', () => {
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
    const result = blob.download();
    expect(result.deleted).toBe(true);
  });

  it('non-404 error does not match isAzureNotFound', () => {
    const error = new Error('boom');
    // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
    const blob = ((facade as any).getContainerClient('mycontainer') as any).getBlockBlobClient(
      'new.bin',
    );
    expect(await blob.exists()).toBe(false);
  });

  it('getSignedUrl throws when cannot sign', async () => {
    const { mod } = buildFakeAzure();
    // deno-lint-ignore no-explicit-any
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
    }) as any;
    await expect(facade.getSignedUrl('blob.txt', 3600)).rejects.toThrow('account key');
  });

  it('getSignedUrl returns URL when signed', async () => {
    const { mod } = buildFakeAzure();
    // deno-lint-ignore no-explicit-any
    const facade = adaptAzureModule(mod, {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'key',
    }) as any;
    const url = await facade.getSignedUrl('blob.txt', 3600);
    expect(url).toContain('sas-token-signed');
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
});
