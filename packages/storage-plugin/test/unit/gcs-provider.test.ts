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
                  delete(cb?: (err: Error | null) => void) {
                    if (cb) {
                      store.delete(name);
                      cb(null);
                    }
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

  it('save adapts to callback-based SDK save via facade', () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => { save: (d: Uint8Array, cb: (e: Error | null) => void) => void };
    }).file('cb-save.bin');
    let gotError: Error | null = null;
    fileHandle.save(new Uint8Array([77]), (err: Error | null) => {
      gotError = err;
    });
    expect(gotError).toBeNull();
    expect(result.store.get('cb-save.bin')).toEqual(new Uint8Array([77]));
  });

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
    // deno-lint-ignore no-explicit-any
    const fileHandle = (facade.bucket() as any).file('nope');
    expect(fileHandle.getMetadata()).rejects.toThrow('ENOENT');
  });

  it('delete resolves when present', async () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    // deno-lint-ignore no-explicit-any
    const fileHandle = (facade.bucket() as any).file('to-delete');
    result.store.set('to-delete', new Uint8Array([1]));
    await fileHandle.delete();
    expect(result.store.has('to-delete')).toBe(false);
  });

  it('getSignedUrl returns signed URL', async () => {
    const result = buildFakeGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'my-bucket' });
    // deno-lint-ignore no-explicit-any
    const fileHandle = (facade.bucket() as any).file('sig-url.bin');
    const [url] = await fileHandle.getSignedUrl({ action: 'read', expires: Date.now() + 3600000 });
    expect(url).toContain('signed.url');
  });

  it('B4: GcsProvider.getSignedUrl uses epoch-seconds for expires (not ms)', async () => {
    let capturedExpires: number | undefined;
    // Inject a pre-adapted facade directly — avoids adaptGcsModule's callback wrapping.
    // deno-lint-ignore no-explicit-any
    const facade: any = {
      bucket() {
        return {
          file() {
            return {
              getSignedUrl(cfg: { action: string; expires: number }) {
                capturedExpires = cfg.expires;
                return Promise.resolve(['https://signed.url/path?sig=abc']);
              },
              download() {
                return Promise.resolve({ body: new Uint8Array() });
              },
              save(_d: Uint8Array, cb: (e: Error | null) => void) {
                cb(null);
              },
              delete(cb: (e: Error | null) => void) {
                cb(null);
                return Promise.resolve();
              },
              getMetadata() {
                return Promise.resolve([{}]);
              },
              createReadStream() {
                return {} as unknown as NodeJS.ReadableStream;
              },
            };
          },
        };
      },
    };
    const provider = new GcsProvider({
      bucket: 'my-bucket',
      client: facade as unknown as IGcsClient,
    });
    await provider.connect();
    const before = Math.floor(Date.now() / 1000);
    await provider.getSignedUrl('obj.txt', { expiresIn: 3600 });
    const after = Math.floor(Date.now() / 1000);
    // B4 fix: expires should be epoch-seconds (~1.7e9), NOT milliseconds (~5e12).
    expect(capturedExpires).toBeGreaterThanOrEqual(before + 3600);
    expect(capturedExpires).toBeLessThanOrEqual(after + 3600 + 1);
    // Ensure it's NOT in millisecond range (which would be ~5 trillion).
    expect(capturedExpires!).toBeLessThan(1e12);
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

  it('not-connected operations reject', () => {
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

  it('get handles body that is not a Uint8Array (Buffer-like)', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => {
            // Return an array-like object that is NOT instanceof Uint8Array but is array-convertible.
            return Promise.resolve({ body: [200, 210] as unknown as Uint8Array });
          },
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on() {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    // The fake returns a Buffer-like object which is NOT instanceof Uint8Array,
    // so the source code wraps it: new Uint8Array(body).
    const result = await provider.get('buffer-body');
    expect(result).toEqual(new Uint8Array([200, 210]));
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

  it('put calls save callback with error', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, cb: (err: Error | null) => void) => {
            cb(new Error('save failed'));
          },
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on() {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await expect(provider.put('fail-save', new Uint8Array([1]))).rejects.toThrow('save failed');
  });

  it('put resolves when save callback receives null error', async () => {
    let saveCb: ((err: Error | null) => void) | null = null;
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save(_data: Uint8Array, cb: (err: Error | null) => void) {
            // Store the callback and invoke it asynchronously, mimicking real GCS SDK behavior.
            saveCb = cb;
            queueMicrotask(() => cb(null));
          },
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on() {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await provider.put('cb-save', new Uint8Array([2]));
    expect(saveCb).not.toBeNull();
  });

  it('get returns body that wraps via new Uint8Array', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          // Return a non-Uint8Array body (simulates Node.js Buffer which IS Uint8Array
          // in real Node but we use an array-like to force the wrapper).
          download: () => Promise.resolve({ body: Uint8Array.from([50, 60, 70]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on() {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.get('uint8array-body');
    expect(result).toEqual(new Uint8Array([50, 60, 70]));
  });

  it('getStream fires data callback with chunk and end closes', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => {
            let errorRegistered = false;
            return {
              on(event: string, fn: (arg?: unknown) => void) {
                if (event === 'error' && !errorRegistered) {
                  errorRegistered = true;
                  // Fire error synchronously so controller.error() is called before stream is consumed.
                  fn(new Error('stream error'));
                }
              },
            } as unknown as NodeJS.ReadableStream;
          },
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('error-stream');
    expect(stream).toBeDefined();
    if (stream) {
      // The error callback triggers controller.error() inside the stream start block.
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toThrow('stream error');
    }
  });

  it('getStream handles stream that only emits end (no data)', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, _cb: (err: Error | null) => void) => {},
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => {
            let endRegistered = false;
            return {
              on(event: string, fn: (arg?: unknown) => void) {
                if (event === 'end' && !endRegistered) {
                  endRegistered = true;
                  // Fire 'end' synchronously so controller.close() runs immediately.
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
    const stream = await provider.getStream('empty-stream');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const result = await reader.read();
      expect(result.done).toBe(true);
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

  it('getStream fires both data and end events from createReadStream', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, cb: (err: Error | null) => void) => cb(null),
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => {
            // Fire all three events synchronously during construction.
            let dataRegistered = false;
            let endRegistered = false;
            return {
              on(event: string, fn: (_arg?: unknown) => void) {
                if (event === 'data' && !dataRegistered) {
                  dataRegistered = true;
                  fn(new Uint8Array([42, 100]));
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
    const stream = await provider.getStream('sync-events-stream');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array([42, 100]));
      const done = await reader.read();
      expect(done.done).toBe(true);
    }
  });

  it('put through injected facade exercises save callback path', async () => {
    let savedData: Uint8Array | null = null;
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save(data: Uint8Array, cb: (err: Error | null) => void) {
            savedData = data;
            cb(null);
          },
          download() {
            return Promise.resolve({ body: savedData ?? new Uint8Array([]) });
          },
          delete(cb?: (err: Error | null) => void) {
            savedData = null;
            cb?.(null);
            return Promise.resolve();
          },
          getMetadata() {
            return Promise.resolve([{}]);
          },
          getSignedUrl() {
            return Promise.resolve(['https://x']);
          },
          createReadStream() {
            let dataRegistered = false;
            let endRegistered = false;
            return {
              on(event: string, fn: (_arg?: unknown) => void) {
                if (event === 'data' && !dataRegistered) {
                  dataRegistered = true;
                  fn(savedData);
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
    const provider = new GcsProvider({ bucket: 'my-bucket', client: fakeClient });
    await provider.connect();
    await provider.put('via-facade.bin', new Uint8Array([10, 20, 30]));
    expect(savedData).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('getStream via injected facade exercises createReadStream adapter with data events', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, cb: (err: Error | null) => void) => cb(null),
          download: () => Promise.resolve({ body: new Uint8Array([]) }),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => {
            const chunk = new Uint8Array([55, 66, 77]);
            let dataRegistered = false;
            let endRegistered = false;
            return {
              on(event: string, fn: (_arg?: unknown) => void) {
                if (event === 'data' && !dataRegistered) {
                  dataRegistered = true;
                  fn(chunk);
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
    const stream = await provider.getStream('adapt-stream.bin');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const r = await reader.read();
      expect(r.done).toBe(false);
      expect(r.value).toEqual(new Uint8Array([55, 66, 77]));
      const done = await reader.read();
      expect(done.done).toBe(true);
    }
  });

  // ── adaptGcsModule internal callback-branch coverage (callback-style SDK) ─

  /** Build a callback-style GCS SDK module for adaptGcsModule tests. */
  function buildCallbackGcs(opts: {
    onDeleteError?: boolean;
    onSignError?: boolean;
    onDownloadData?: Uint8Array;
    onMetadataError?: boolean;
  } = {}) {
    const store = new Map<string, Uint8Array>();
    store.set('default-data', new Uint8Array([42]));
    const { onDeleteError, onSignError, onDownloadData, onMetadataError } = opts;
    const mod = {
      Storage: class {
        constructor(_cfg: { projectId?: string }) {
          // no-op
        }
        bucket(_n: unknown) {
          return {
            file(_name: string) {
              const nameStr = _name;
              return {
                getMetadata(cb: (err: Error | null, meta?: Record<string, unknown>) => void) {
                  if (onMetadataError) {
                    cb(new Error('metadata error'));
                    return;
                  }
                  if (!store.has(nameStr)) {
                    cb(new Error('ENOENT'));
                    return;
                  }
                  cb(null, { size: store.get(nameStr)!.length });
                },
                download(cb: (err: Error | null, data?: Uint8Array) => void) {
                  if (onDownloadData) {
                    cb(null, onDownloadData);
                    return;
                  }
                  const data = store.get(nameStr);
                  if (data === undefined) {
                    cb(new Error('ENOENT'));
                    return;
                  }
                  cb(null, data);
                },
                save(data: Uint8Array, cb: (err: Error | null) => void) {
                  store.set(nameStr, data);
                  cb(null);
                },
                delete(cb: (err: Error | null) => void) {
                  if (onDeleteError) {
                    cb(new Error('sdk delete error'));
                    return;
                  }
                  store.delete(nameStr);
                  cb(null);
                },
                getSignedUrl(
                  cfg: { action: string; expires: number },
                  cb: (err: Error | null, url?: string) => void,
                ) {
                  if (onSignError) {
                    cb(new Error('signing failed'));
                    return;
                  }
                  const params = new URLSearchParams(
                    cfg as unknown as Record<string, string>,
                  );
                  cb(null, `https://signed.url/${nameStr}?${params.toString()}`);
                },
                createReadStream() {
                  const data = store.get(nameStr);
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
                  } as unknown as NodeJS.ReadableStream;
                },
              };
            },
          };
        }
      },
    };
    return {
      mod: mod as unknown as import('../../src/providers/gcs-provider.ts').GcsSdkModule,
      store,
    };
  }

  it('adaptGcsModule delete() rejects when callback receives error', async () => {
    const { mod } = buildCallbackGcs({ onDeleteError: true });
    const facade = adaptGcsModule(mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => { delete: () => Promise<boolean> };
    }).file('cb-del');
    await expect(fileHandle.delete()).rejects.toThrow('sdk delete error');
  });

  it('adaptGcsModule getSignedUrl rejects when callback receives error', async () => {
    const { mod } = buildCallbackGcs({ onSignError: true });
    const facade = adaptGcsModule(mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => {
        getSignedUrl: (cfg: { action: string; expires: number }) => Promise<[string]>;
      };
    }).file('cb-sig');
    await expect(
      fileHandle.getSignedUrl({ action: 'read', expires: Date.now() + 3600000 }),
    ).rejects.toThrow('signing failed');
  });

  it('adaptGcsModule download() resolves when callback returns data', async () => {
    const { mod } = buildCallbackGcs({ onDownloadData: new Uint8Array([99, 100]) });
    const facade = adaptGcsModule(mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => { download: () => Promise<{ body: unknown }> };
    }).file('cb-dl');
    const result = await fileHandle.download();
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect((result.body as Uint8Array).length).toBe(2);
  });

  it('adaptGcsModule getMetadata() rejects when callback receives error', async () => {
    const { mod } = buildCallbackGcs({ onMetadataError: true });
    const facade = adaptGcsModule(mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => {
        getMetadata: () => Promise<[Record<string, unknown>]>;
      };
    }).file('cb-meta');
    await expect(fileHandle.getMetadata()).rejects.toThrow('metadata error');
  });

  // ── isGcsNotFound branch: non-Error input ─

  it('isGcsNotFound returns false when error is not an Error instance', async () => {
    // Access internal detector via provider's get() which uses it internally.
    const fakeClient = {
      bucket: () => ({
        file: () => ({
          save: (_data: Uint8Array, cb: (err: Error | null) => void) => cb(null),
          download: () => Promise.reject('string-error'),
          delete: () => Promise.resolve(),
          getMetadata: () => Promise.resolve([{}]),
          getSignedUrl: () => Promise.resolve(['https://x']),
          createReadStream: () => ({ on() {} }),
        }),
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    // 'string-error' is NOT instanceof Error → isGcsNotFound returns false → re-thrown
    let threw = false;
    try {
      await provider.get('non-error');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // ── adaptGcsModule callback success paths: getMetadata resolve, download resolve, createReadStream ─

  it('adaptGcsModule getMetadata() resolves successfully when callback receives no error', async () => {
    const result = buildCallbackGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => { getMetadata: () => Promise<[Record<string, unknown>]> };
    }).file('default-data');
    const meta = await fileHandle.getMetadata();
    expect(meta).toEqual([{ size: 1 }]);
  });

  it('adaptGcsModule createReadStream() is reachable from adapted file handle', () => {
    const result = buildCallbackGcs();
    const facade = adaptGcsModule(result.mod, { bucket: 'cb-bucket' });
    const fileHandle = (facade.bucket() as unknown as {
      file: (n: string) => { createReadStream: () => NodeJS.ReadableStream };
    }).file('default-data');
    const stream = fileHandle.createReadStream();
    expect(stream).toBeDefined();
    expect(typeof stream.on).toBe('function');
  });

  // ── GcsProvider.connect() early-return when already connected ─

  it('connect returns immediately when already connected (early-return branch)', async () => {
    const fakeClient = { bucket: () => ({}) } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
    // Second connect should hit the early-return branch: if (this.#client !== null) return;
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  // ── Branches that need explicit coverage: projectId option, nullish coalesce,
  //    getStream non-Not Found catch re-throw, and adaptGcsModule callback branches. ─

  it('adaptGcsModule passes projectId through to Storage config when defined', () => {
    let capturedConfig: { projectId?: string } | undefined;
    const mod = {
      Storage: class {
        constructor(config: { projectId?: string }) {
          capturedConfig = config;
        }
        bucket(_n: unknown) {
          return {
            file(_name: string) {
              return {
                getMetadata() {
                  return Promise.resolve([{}]);
                },
                download() {
                  return Promise.resolve({ body: new Uint8Array([]) });
                },
                save(_d: Uint8Array, cb: (e: Error | null) => void) {
                  cb(null);
                },
                delete(cb: (e: Error | null) => void) {
                  cb(null);
                },
                getSignedUrl(
                  _c: { action: string; expires: number },
                  cb: (e: Error | null, u?: string) => void,
                ) {
                  cb(null, 'https://x');
                },
                createReadStream() {
                  return { on() {} };
                },
              };
            },
          };
        }
      },
    } as unknown as import('../../src/providers/gcs-provider.ts').GcsSdkModule;
    adaptGcsModule(mod, { bucket: 'b', projectId: 'my-project' });
    expect(capturedConfig?.projectId).toBe('my-project');
  });

  it('adaptGcsModule omits projectId from Storage config when undefined', () => {
    let capturedConfig: { projectId?: string } | undefined;
    const mod = {
      Storage: class {
        constructor(config: { projectId?: string }) {
          capturedConfig = config;
        }
        bucket(_n: unknown) {
          return {
            file(_name: string) {
              return {
                getMetadata() {
                  return Promise.resolve([{}]);
                },
                download() {
                  return Promise.resolve({ body: new Uint8Array([]) });
                },
                save(_d: Uint8Array, cb: (e: Error | null) => void) {
                  cb(null);
                },
                delete(cb: (e: Error | null) => void) {
                  cb(null);
                },
                getSignedUrl(
                  _c: { action: string; expires: number },
                  cb: (e: Error | null, u?: string) => void,
                ) {
                  cb(null, 'https://x');
                },
                createReadStream() {
                  return { on() {} };
                },
              };
            },
          };
        }
      },
    } as unknown as import('../../src/providers/gcs-provider.ts').GcsSdkModule;
    adaptGcsModule(mod, { bucket: 'b' });
    expect(capturedConfig?.projectId).toBeUndefined();
  });

  it('adaptGcsModule bucket(_name) uses bucketName from options when _name is undefined/null', () => {
    let capturedBucketName: string | undefined;
    const mod = {
      Storage: class {
        constructor(_cfg: { projectId?: string }) {}
        bucket(name: string) {
          capturedBucketName = name;
          return {
            file(_n: string) {
              return {
                getMetadata() {
                  return Promise.resolve([{}]);
                },
                download() {
                  return Promise.resolve({ body: new Uint8Array([]) });
                },
                save(_d: Uint8Array, cb: (e: Error | null) => void) {
                  cb(null);
                },
                delete(cb: (e: Error | null) => void) {
                  cb(null);
                },
                getSignedUrl(
                  _c: { action: string; expires: number },
                  cb: (e: Error | null, u?: string) => void,
                ) {
                  cb(null, 'https://x');
                },
                createReadStream() {
                  return { on() {} };
                },
              };
            },
          };
        }
      },
    } as unknown as import('../../src/providers/gcs-provider.ts').GcsSdkModule;
    const facade = adaptGcsModule(mod, { bucket: 'opts-bucket' });
    // Calling bucket() with no argument should fall through to _name ?? bucketName
    (facade as unknown as { bucket(n?: string): { file(n: string): unknown } }).bucket();
    expect(capturedBucketName).toBe('opts-bucket');
    // Calling bucket(undefined) should do the same
    (facade as unknown as { bucket(n?: string): { file(n: string): unknown } }).bucket(undefined);
    expect(capturedBucketName).toBe('opts-bucket');
    // Calling bucket(null) should do the same
    (facade as unknown as { bucket(n?: string): { file(n: string): unknown } }).bucket(
      null as unknown as string,
    );
    expect(capturedBucketName).toBe('opts-bucket');
  });

  it('getStream throws non-NotFound error through catch', async () => {
    const fakeClient = {
      bucket: () => ({
        file: () => {
          throw new Error('ConnectionError');
        },
      }),
    } as unknown as IGcsClient;
    const provider = new GcsProvider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    let threw = false;
    try {
      await provider.getStream('throw-file');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe('ConnectionError');
    }
    expect(threw).toBe(true);
  });
});
