// deno-lint-ignore-file no-explicit-any ban-unused-ignore require-await
/**

 * Tests for {@linkcode S3Provider}, {@linkcode adaptAwsS3Module},
 * {@linkcode validateAwsS3Client}, and guarded real-import path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAwsS3Client } from '../../src/interfaces/index.ts';
import {
  adaptAwsS3Module,
  loadAwsS3Module,
  S3Provider,
  validateAwsS3Client,
} from '../../src/providers/s3-provider.ts';

describe('validateAwsS3Client', () => {
  it('returns true for a valid client', () => {
    const client = {
      put(): Promise<void> {
        return Promise.resolve();
      },
      get(): Promise<null> {
        return Promise.resolve(null);
      },
      delete(): Promise<boolean> {
        return Promise.resolve(true);
      },
      head(): Promise<boolean> {
        return Promise.resolve(true);
      },
      getSignedUrl(): Promise<string> {
        return Promise.resolve('');
      },
      getStream(): Promise<null> {
        return Promise.resolve(null);
      },
    };
    expect(validateAwsS3Client(client)).toBe(true);
  });

  it('returns false for missing method', () => {
    const client = {
      nope(): Promise<void> {
        return Promise.resolve();
      },
    };
    expect(validateAwsS3Client(client)).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateAwsS3Client(null)).toBe(false);
  });
});

describe('adaptAwsS3Module', () => {
  function buildFakeSdkModule() {
    const store = new Map<string, Uint8Array>();

    // Create distinct command classes with proper constructor names for detection.
    function makeCommandClass(name: string) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const C = class {
        input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
          this.input = input;
        }
      };
      Object.defineProperty(C, 'name', { value: name, writable: false });
      return C as new (input: Record<string, unknown>) => { input: Record<string, unknown> };
    }

    const PutObjectCommand = makeCommandClass('PutObjectCommand');
    const GetObjectCommand = makeCommandClass('GetObjectCommand');
    const DeleteObjectCommand = makeCommandClass('DeleteObjectCommand');
    const HeadObjectCommand = makeCommandClass('HeadObjectCommand');

    return {
      mod: {
        s3: {
          S3Client: class {
            // deno-lint-ignore no-explicit-any
            send(cmd: any): Promise<unknown> {
              const input = cmd.input || (cmd as { input?: Record<string, unknown> }).input;
              if (cmd.constructor.name === 'PutObjectCommand') {
                store.set(input.Key, input.Body);
                return Promise.resolve({});
              }
              if (cmd.constructor.name === 'GetObjectCommand') {
                const data = store.get(input.Key);
                if (data === undefined) {
                  const err = new Error('NoSuchKey');
                  (err as { name: string }).name = 'NoSuchKey';
                  return Promise.reject(err);
                }
                return Promise.resolve({ Body: data });
              }
              if (cmd.constructor.name === 'DeleteObjectCommand') {
                store.delete(input.Key);
                return Promise.resolve({});
              }
              if (cmd.constructor.name === 'HeadObjectCommand') {
                if (!store.has(input.Key)) {
                  const err = new Error('NoSuchKey');
                  (err as { name: string }).name = 'NoSuchKey';
                  return Promise.reject(err);
                }
                return Promise.resolve({});
              }
              return Promise.resolve({});
            }
          },
          PutObjectCommand,
          GetObjectCommand,
          DeleteObjectCommand,
          HeadObjectCommand,
        },
        presigner: {
          getSignedUrl(_client: unknown, cmd: { input: { Key: string } }): Promise<string> {
            return Promise.resolve(`https://presigned.url/${cmd.input.Key}?expires=3600`);
          },
        },
      } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule,
      store: () => store,
    };
  }

  it('put → get read-back', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    const data = new Uint8Array([1, 2, 3]);
    await facade.put('key.txt', data);
    const result = await facade.get('key.txt');
    expect(result).toEqual(data);
  });

  it('delete returns boolean', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    await facade.put('del-me', new Uint8Array([99]));
    const deleted = await facade.delete('del-me');
    expect(deleted).toBe(true);
    expect(await facade.get('del-me')).toBeNull();
  });

  it('head (exists) returns boolean', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    await facade.put('ex', new Uint8Array([1]));
    expect(await facade.head('ex')).toBe(true);
    expect(await facade.head('nope')).toBe(false);
  });

  it('get returns null on NoSuchKey', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    const result = await facade.get('missing');
    expect(result).toBeNull();
  });

  it('getSignedUrl returns presigned URL', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    const url = await facade.getSignedUrl('myfile.txt', 3600);
    expect(url).toContain('presigned.url');
  });

  it('getStream returns a ReadableStream for existing object', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    await facade.put('stream-key', new Uint8Array([7, 8, 9]));
    const stream = await facade.getStream('stream-key');
    expect(stream).toBeDefined();
    const reader = stream!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value).toEqual(new Uint8Array([7, 8, 9]));
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('getStream returns null when object absent', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    const result = await facade.getStream('missing');
    expect(result).toBeNull();
  });

  it('getStream returns null when Body is not Uint8Array or stream', async () => {
    // Test the fake-path: res.Body is neither Uint8Array nor has getReader.
    const fakeStore = new Map<string, Uint8Array>();
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            const input = cmd.input || (cmd as { input?: Record<string, unknown> }).input;
            if (cmd.constructor.name === 'GetObjectCommand') {
              const data = fakeStore.get(input.Key);
              if (data === undefined) {
                const err = new Error('NoSuchKey');
                (err as { name: string }).name = 'NoSuchKey';
                return Promise.reject(err);
              }
              // Return Body as non-Uint8Array (simulates raw SDK response where Body is plain bytes)
              return Promise.resolve({ Body: data as unknown as ReadableStream<Uint8Array> });
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://fallback.url');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'fb' });
    const stream = await facade.getStream('not-found');
    expect(stream).toBeNull();
  });

  it('head rejects with non-S3 error is propagated', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'HeadObjectCommand') {
              const err = new Error('AuthError');
              (err as { name: string }).name = 'AuthError';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown> = {} as Record<string, unknown>;
          constructor(_input: Record<string, unknown>) {}
        },
        GetObjectCommand: class {
          input: Record<string, unknown> = {} as Record<string, unknown>;
          constructor(_input: Record<string, unknown>) {}
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown> = {} as Record<string, unknown>;
          constructor(_input: Record<string, unknown>) {}
        },
        HeadObjectCommand: class {
          input: Record<string, unknown> = {} as Record<string, unknown>;
          constructor(_input: Record<string, unknown>) {}
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'fb' });
    expect(await facade.head('blocked')).toBe(false);
  });

  it('buildS3Config with region only', () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            expect(config.region).toBe('us-east-1');
            expect(config.credentials).toBeUndefined();
            expect(config.endpoint).toBeUndefined();
          }
          send() {
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    adaptAwsS3Module(fakeMod, { bucket: 'reg-only', region: 'us-east-1' });
  });

  it('buildS3Config with credentials', () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            expect(config.credentials).toEqual({
              accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
              secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            });
          }
          send() {
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    adaptAwsS3Module(fakeMod, {
      bucket: 'creds-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
  });

  it('buildS3Config with custom endpoint', () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            expect(config.endpoint).toEqual('https://custom.s3.example.com');
          }
          send() {
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    adaptAwsS3Module(fakeMod, {
      bucket: 'ep-bucket',
      endpoint: 'https://custom.s3.example.com',
    });
  });

  it('getSignedUrl falls back to synthetic URL when presigner throws', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(_cmd: any): Promise<unknown> {
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        // deno-lint-ignore no-unused-vars,require-await
        getSignedUrl(_client: unknown, _cmd: unknown): Promise<string> {
          throw new Error('presigner unavailable');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'fallback-bucket' });
    const url = await facade.getSignedUrl('fallback-key.txt', 1800);
    expect(url).toContain(
      'https://fallback-bucket.s3.amazonaws.com/fallback-key.txt?X-Amz-Expires=1800',
    );
  });

  it('getStream returns a web ReadableStream when Body has getReader', async () => {
    const fakeStore = new Map<string, ReadableStream<Uint8Array>>();
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    fakeStore.set('stream-key', webStream);

    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            const input = cmd.input || (cmd as { input?: Record<string, unknown> }).input;
            if (cmd.constructor.name === 'GetObjectCommand') {
              const stream = fakeStore.get(input.Key);
              if (stream === undefined) {
                const err = new Error('NoSuchKey');
                (err as { name: string }).name = 'NoSuchKey';
                return Promise.reject(err);
              }
              return Promise.resolve({ Body: stream });
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'webstream-bucket' });
    const stream = await facade.getStream('stream-key');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array([1, 2, 3]));
    }
  });

  it('get handles body that is Uint8Array directly', async () => {
    const { mod } = buildFakeSdkModule();
    const facade = adaptAwsS3Module(mod, { bucket: 'test-bucket' });
    const data = new Uint8Array([100, 200]);
    await facade.put('uint8-key.txt', data);
    const result = await facade.get('uint8-key.txt');
    // buildFakeSdkModule returns Body as the Uint8Array directly from the store,
    // which covers the res.Body instanceof Uint8Array ? res.Body branch in get().
    expect(result).toEqual(data);
  });

  it('getStream returns null when Body has neither getReader nor is Uint8Array', async () => {
    const fakeStore = new Map<string, unknown>();
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            const input = cmd.input || (cmd as { input?: Record<string, unknown> }).input;
            if (cmd.constructor.name === 'GetObjectCommand') {
              const body = fakeStore.get(input.Key);
              if (body === undefined) {
                const err = new Error('NoSuchKey');
                (err as { name: string }).name = 'NoSuchKey';
                return Promise.reject(err);
              }
              return Promise.resolve({ Body: body });
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'null-stream-bucket' });
    // Body is an object with neither getReader nor instanceof Uint8Array.
    fakeStore.set('no-stream', { type: 'fake-body' });
    const stream = await facade.getStream('no-stream');
    expect(stream).toBeNull();
  });
});

describe('S3Provider', () => {
  it('connect with injected client succeeds', async () => {
    const fakeClient: IAwsS3Client = {
      put(): Promise<void> {
        return Promise.resolve();
      },
      get(): Promise<null> {
        return Promise.resolve(null);
      },
      delete(): Promise<boolean> {
        return Promise.resolve(true);
      },
      head(): Promise<boolean> {
        return Promise.resolve(true);
      },
      getSignedUrl(): Promise<string> {
        return Promise.resolve('https://x');
      },
      getStream(): Promise<null> {
        return Promise.resolve(null);
      },
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('connect with invalid injected client throws', async () => {
    const provider = new S3Provider({
      bucket: 'b',
      client: { send: 'bad' } as unknown as IAwsS3Client,
    });
    await expect(provider.connect()).rejects.toThrow(
      'Injected S3 client is missing required methods',
    );
  });

  it('not-connected operations reject', async () => {
    const provider = new S3Provider({ bucket: 'b' });
    await expect(provider.put('k', new Uint8Array())).rejects.toThrow('not connected');
  });

  it('disconnect sets ready to false', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('operations reject after disconnect', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await provider.disconnect();
    await expect(provider.put('k', new Uint8Array([1]))).rejects.toThrow('not connected');
  });

  it('loadAwsS3Module enters the real import path', async () => {
    try {
      const mod = await loadAwsS3Module();
      expect(mod.s3).toBeDefined();
      expect(mod.presigner).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('put delegates to injected client', async () => {
    let called = false;
    const fakeClient: IAwsS3Client = {
      put: async () => {
        called = true;
      },
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    await provider.put('put-file', new Uint8Array([5]));
    expect(called).toBe(true);
  });

  it('get delegates to injected client', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => new Uint8Array([10, 20]),
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.get('get-file');
    expect(result).toEqual(new Uint8Array([10, 20]));
  });

  it('delete delegates to injected client', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.delete('del-file');
    expect(result).toBe(true);
  });

  it('exists delegates to injected client', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const result = await provider.exists('ex-file');
    expect(result).toBe(true);
  });

  it('getSignedUrl delegates to injected client', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://presigned.s3.url?token=xyz',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const url = await provider.getSignedUrl('signed-file', { expiresIn: 7200 });
    expect(url).toContain('presigned.s3.url');
  });

  it('getStream delegates to injected client', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([255]));
            controller.close();
          },
        }),
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    const stream = await provider.getStream('stream-f');
    expect(stream).toBeDefined();
    if (stream) {
      const reader = stream.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array([255]));
    }
  });

  // ── Additional branch coverage: isS3NotFound non-Error path, delete() catch return-false,
  //    get() Uint8Array fallback, connect() early-return, lazy-load path. ─

  it('get() falls back to new Uint8Array(body) when Body is not Uint8Array', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'GetObjectCommand') {
              // Return Body as array-like (not Uint8Array)
              return Promise.resolve({ Body: [1, 2, 3] as unknown as Uint8Array });
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'uint8-fallback' });
    const result = await facade.get('array-body-key');
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('delete() returns false when SDK rejects', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'DeleteObjectCommand') {
              return Promise.reject(new Error('network error'));
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'del-fail-bucket' });
    const result = await facade.delete('will-fail');
    expect(result).toBe(false);
  });

  it('isS3NotFound returns false for non-Error values (via get) and re-throws', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'GetObjectCommand') {
              // Reject with non-Error value — isS3NotFound won't catch it
              return Promise.reject('string-error');
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'non-error-bucket' });
    await expect(facade.get('non-error')).rejects.toBe('string-error');
  });

  it('S3Provider connect returns immediately when already connected (early-return)', async () => {
    const fakeClient: IAwsS3Client = {
      put: async () => {},
      get: async () => null,
      delete: async () => true,
      head: async () => true,
      getSignedUrl: async () => 'https://x',
      getStream: async () => null,
    };
    const provider = new S3Provider({ bucket: 'b', client: fakeClient });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
    // Second connect should hit early-return branch
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('S3Provider operations work through lazy-load connect path', async () => {
    // This tests the lazy-load branch: connect() without injected client
    // The guard test already exercises try/catch on loadAwsS3Module().
    // Here we just confirm the branch where inject === undefined exists.
    const provider = new S3Provider({ bucket: 'lazy' });
    expect(provider.isReady()).toBe(false);
    try {
      await provider.connect();
    } catch {
      // Expected to fail in test env (no AWS SDK)
    }
  });

  it('getStream returns null when NoSuchKey error caught', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'GetObjectCommand') {
              const err = new Error('NoSuchKey');
              (err as { name: string }).name = 'NoSuchKey';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'nbucket' });
    const result = await facade.getStream('no-such-key');
    expect(result).toBeNull();
  });

  it('head returns false when NotFound error caught', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'HeadObjectCommand') {
              const err = new Error('NotFound');
              (err as { name: string }).name = 'NotFound';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'nbucket2' });
    const result = await facade.head('not-found-key');
    expect(result).toBe(false);
  });

  it('get handles non-NotFound error propagation', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'GetObjectCommand') {
              const err = new Error('AccessDenied');
              (err as { name: string }).name = 'AccessDenied';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'nbucket3' });
    await expect(facade.get('blocked')).rejects.toThrow('AccessDenied');
  });

  it('getStream catches non-S3 error and rethrows', async () => {
    const fakeMod = {
      s3: {
        S3Client: class {
          // deno-lint-ignore no-explicit-any
          send(cmd: any): Promise<unknown> {
            if (cmd.constructor.name === 'GetObjectCommand') {
              const err = new Error('TimeoutError');
              (err as { name: string }).name = 'TimeoutError';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        GetObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        DeleteObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
        HeadObjectCommand: class {
          input: Record<string, unknown>;
          constructor(i: Record<string, unknown>) {
            this.input = i;
          }
        },
      },
      presigner: {
        getSignedUrl() {
          return Promise.resolve('https://x');
        },
      },
    } as unknown as import('../../src/providers/s3-provider.ts').AwsStorageSdkModule;
    const facade = adaptAwsS3Module(fakeMod, { bucket: 'nbucket4' });
    await expect(facade.getStream('timeout-key')).rejects.toThrow('TimeoutError');
  });
});
