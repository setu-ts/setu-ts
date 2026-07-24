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
      put(): Promise<void> { return Promise.resolve(); },
      get(): Promise<null> { return Promise.resolve(null); },
      delete(): Promise<boolean> { return Promise.resolve(true); },
      head(): Promise<boolean> { return Promise.resolve(true); },
      getSignedUrl(): Promise<string> { return Promise.resolve(''); },
      getStream(): Promise<null> { return Promise.resolve(null); },
    };
    expect(validateAwsS3Client(client)).toBe(true);
  });

  it('returns false for missing method', () => {
    const client = { nope(): Promise<void> { return Promise.resolve(); } };
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
      const C = class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } };
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
});

describe('S3Provider', () => {
  it('connect with injected client succeeds', async () => {
    const fakeClient: IAwsS3Client = {
      put(): Promise<void> { return Promise.resolve(); },
      get(): Promise<null> { return Promise.resolve(null); },
      delete(): Promise<boolean> { return Promise.resolve(true); },
      head(): Promise<boolean> { return Promise.resolve(true); },
      getSignedUrl(): Promise<string> { return Promise.resolve('https://x'); },
      getStream(): Promise<null> { return Promise.resolve(null); },
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
    const provider = new S3Provider({ bucket: 'b' });
    await provider.connect();
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
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
});
