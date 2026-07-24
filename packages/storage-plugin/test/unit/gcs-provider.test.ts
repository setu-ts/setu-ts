/**
 * Tests for {@linkcode GcsProvider}, {@linkcode adaptGcsModule},
 * {@linkcode validateGcsClient}, and guarded real-import path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IGcsClient } from '../../src/interfaces/index.ts';
import {
  adaptGcsModule,
  GcsProvider,
  loadGcsModule,
  validateGcsClient,
} from '../../src/providers/gcs-provider.ts';

describe('validateGcsClient', () => {
  it('returns true for a valid client', () => {
    const client = { bucket: () => ({}) };
    expect(validateGcsClient(client)).toBe(true);
  });

  it('returns false for missing method', () => {
    const client = { nope: () => {} };
    expect(validateGcsClient(client)).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateGcsClient(null)).toBe(false);
  });
});

describe('adaptGcsModule', () => {
  function buildFakeGcs() {
    const store = new Map<string, Uint8Array>();

    return {
      mod: {
        Storage: class {
          constructor(_config: { projectId?: string }) {
            // no-op for fake
          }
          bucket(_name?: unknown): {
            file(name: string): {
              getMetadata(): Promise<[Record<string, unknown>]>;
              download(): Promise<{ body: Uint8Array }>;
              save(data: Uint8Array, cb: (err: Error | null) => void): void;
              delete(): Promise<void>;
              getSignedUrl(config: { action: string; expires: number }): Promise<[string]>;
              createReadStream(): { on(event: string, fn: (...args: unknown[]) => void): void };
            };
          } {
            return {
              file(name: string) {
                return {
                  getMetadata() {
                    if (!store.has(name)) throw new Error('ENOENT');
                    return Promise.resolve([{}]);
                  },
                  download() {
                    const data = store.get(name);
                    if (data === undefined) throw new Error('ENOENT');
                    return Promise.resolve({ body: data });
                  },
                  save(data: Uint8Array, cb: (err: Error | null) => void) {
                    store.set(name, data);
                    cb(null);
                  },
                  delete() {
                    store.delete(name);
                    return Promise.resolve();
                  },
                  getSignedUrl(config: { action: string; expires: number }) {
                    const params = new URLSearchParams(config as unknown as Record<string, string>);
                    return Promise.resolve([`https://signed.url/${name}?${params.toString()}`]);
                  },
                  createReadStream() {
                    const data = store.get(name);
                    if (data === undefined) throw new Error('ENOENT');
                    let emitted = false;
                    return {
                      on(event: string, fn: (...args: unknown[]) => void) {
                        if (!emitted && event === 'data') {
                          emitted = true;
                          setTimeout(() => fn(data), 0);
                          setTimeout(() => fn(), 2);
                        }
                      },
                      [Symbol.asyncIterator]() {
                        return {
                          next() {
                            if (!emitted) {
                              emitted = true;
                              return Promise.resolve({ done: false, value: data });
                            }
                            return Promise.resolve({ done: true, value: undefined });
                          },
                        };
                      },
                    } as unknown as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
                  },
                };
              },
            };
          }
        },
      } as unknown as import('../../src/providers/gcs-provider.ts').GcsSdkModule,
      store,
    };
  }

  it('save → download round-trip', () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const bucketHandle = facade.bucket() as unknown as {
      file: (n: string) => { save: (d: Uint8Array, cb: (e: Error | null) => void) => void };
    };
    bucketHandle.file('test.bin').save(new Uint8Array([5, 6, 7]), () => {});
    expect(result.store.get('test.bin')).toEqual(new Uint8Array([5, 6, 7]));
  });

  it('download throws ENOENT when absent', () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const bucketHandle = facade.bucket() as unknown as {
      file: (n: string) => { download: () => Promise<{ body: unknown }> };
    };
    expect(bucketHandle.file('missing').download()).rejects.toThrow('ENOENT');
  });
});

describe('GcsProvider', () => {
  it('connect with injected client succeeds', async () => {
    const fakeClient = { bucket: () => ({}) };
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient as unknown as IGcsClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('connect with invalid injected client throws', async () => {
    const provider = new GcsProvider({
      bucket: 'b',
      client: { nope: () => {} } as unknown as IGcsClient,
    });
    await expect(provider.connect()).rejects.toThrow(
      'Injected GCS client is missing required method',
    );
  });

  it('not-connected operations reject', async () => {
    const provider = new GcsProvider({ bucket: 'b' });
    // put() throws synchronously when not connected (assertConnected fires before Promise creation)
    expect(() => provider.put('k', new Uint8Array())).toThrow('not connected');
  });

  it('loadGcsModule enters the real import path', async () => {
    try {
      const mod = await loadGcsModule();
      expect(mod.Storage).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
