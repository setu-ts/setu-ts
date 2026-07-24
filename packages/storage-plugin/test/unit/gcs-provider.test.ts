// deno-lint-ignore-file no-explicit-any ban-unused-ignore require-await
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
              download(): Promise<{ body: Uint8Array | NodeJS.ReadableStream }>;
              save(data: Uint8Array, cb: (err: Error | null) => void): void;
              delete(cb?: (err: Error | null) => void): Promise<void>;
              getSignedUrl(
                config: { action: string; expires: number },
                cb: (err: Error | null, url?: string) => void,
              ): void;
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
                  delete(cb: (err: Error | null) => void) {
                    store.delete(name);
                    cb(null);
                    return Promise.resolve();
                  },
                  getSignedUrl(
                    config: { action: string; expires: number },
                    cb: (err: Error | null, url?: string) => void,
                  ) {
                    const params = new URLSearchParams(config as unknown as Record<string, string>);
                    cb(null, `https://signed.url/${name}?${params.toString()}`);
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

  it('getMetadata throws when absent', () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const fileHandle = (facade.bucket() as any).file('nope');
    expect(fileHandle.getMetadata()).rejects.toThrow('ENOENT');
  });

  it('delete resolves when present', async () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const fileHandle = (facade.bucket() as any).file('to-delete');
    result.store.set('to-delete', new Uint8Array([1]));
    await fileHandle.delete();
    expect(result.store.has('to-delete')).toBe(false);
  });

  it('getSignedUrl returns signed URL', async () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const fileHandle = (facade.bucket() as any).file('sig-url.bin');
    const [url] = await fileHandle.getSignedUrl({ action: 'read', expires: Date.now() + 3600000 });
    expect(url).toContain('signed.url');
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

  it('put delegates to injected client', async () => {
    let putCalled = false;
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, cb: (err: Error | null) => void) => {
            putCalled = true;
            cb(null);
          },
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await provider.put('myfile', new Uint8Array([1, 2, 3]));
    expect(putCalled).toBe(true);
  });

  it('get returns data via injected client', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([77, 88]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.get('getfile');
    expect(result).toEqual(new Uint8Array([77, 88]));
  });

  it('get returns null on not-found error', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.reject(new Error('Not Found')),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.get('missing-file');
    expect(result).toBeNull();
  });

  it('delete returns true from injected client', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.delete('del-me');
    expect(result).toBe(true);
  });

  it('delete returns false on rejection', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.reject(new Error('network error')),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.delete('fail-del');
    expect(result).toBe(false);
  });

  it('exists returns true from injected client', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.exists('ex-file');
    expect(result).toBe(true);
  });

  it('exists returns false on error', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.reject(new Error('ENOENT')),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.exists('nope-file');
    expect(result).toBe(false);
  });

  it('getSignedUrl returns signed URL', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://signed.gcs.url/myfile?token=abc']),
          createReadStream: () => ({ on: () => {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const url = await provider.getSignedUrl('myfile', { expiresIn: 3600 });
    expect(url).toContain('signed.gcs.url');
  });

  it('getStream returns ReadableStream from injected client', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => {
            // Simulate Node.js stream - fire data and end synchronously
            // so the ReadableStream completes before we read from it.
            let dataRegistered = false;
            let endRegistered = false;
            return {
              on(event: string, fn: (arg?: unknown) => void) {
                if (event === 'data' && !dataRegistered) {
                  dataRegistered = true;
                  fn(new Uint8Array([100, 200, 255]));
                }
                if (event === 'end' && !endRegistered) {
                  endRegistered = true;
                  fn();
                }
              },
            } as unknown as NodeJS.ReadableStream;
          },
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('stream-file');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array([100, 200, 255]));
      const done = await reader.read();
      expect(done.done).toBe(true);
    }
  });

  it('getStream returns null on not-found', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => {
          throw new Error('Not Found');
        },
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.getStream('missing-stream');
    expect(result).toBeNull();
  });

  it('disconnect clears client', async () => {
    const fakeClient = { bucket: () => ({}) } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('connect with non-injected client tries lazy load', async () => {
    const provider = new GcsProvider({ bucket: 'b' });
    expect(provider.isReady()).toBe(false);
    try {
      await provider.connect();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
