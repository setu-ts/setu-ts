/**
 * X8-6 — object attributes reaching the backend.
 *
 * `IStorage.put(path, data)` took no metadata, so every stored object was
 * `application/octet-stream` and a presigned URL — the entire point of the
 * feature that produces one — downloaded the object instead of rendering it.
 *
 * Each provider is asserted on the TRANSLATED backend call rather than on the
 * `IStorage` surface, because the three cloud backends each spell the same two
 * attributes differently and a shared assertion would prove none of them: S3
 * takes `ContentType`/`Metadata` on the command, GCS takes
 * `contentType`/`metadata` in `save`'s options bag, and Azure buries the
 * content type inside `blobHTTPHeaders.blobContentType`.
 *
 * The memory and local providers are asserted the other way — that they accept
 * the options and store the bytes unchanged — because that is the documented
 * behaviour and a test is what stops it drifting into a half-implementation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IFileSystem, PutObjectOptions } from '@setu-ts/common';
import { StorageService } from '../../src/services/storage-service.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { LocalStorageProvider } from '../../src/providers/local-provider.ts';
import { adaptAwsS3Module } from '../../src/providers/s3-provider.ts';
import { adaptGcsModule } from '../../src/providers/gcs-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import type { IAzureBlobClient } from '../../src/interfaces/index.ts';

const BYTES = new Uint8Array([137, 80, 78, 71]);
const PNG: PutObjectOptions = {
  contentType: 'image/png',
  metadata: { owner: 'ada' },
};

describe('S3Provider — object attributes on the command (X8-6)', () => {
  /** Records the input every `PutObjectCommand` was constructed with. */
  function buildFakeS3() {
    const commands: Record<string, unknown>[] = [];
    const mod = {
      s3: {
        S3Client: class {
          send(_command: unknown): Promise<unknown> {
            return Promise.resolve({});
          }
        },
        PutObjectCommand: class {
          constructor(input: Record<string, unknown>) {
            commands.push(input);
          }
        },
        GetObjectCommand: class {},
        DeleteObjectCommand: class {},
        HeadObjectCommand: class {},
      },
      presigner: { getSignedUrl: () => Promise.resolve('https://signed') },
    } as unknown as AwsStorageSdkModule;
    return { client: adaptAwsS3Module(mod, { bucket: 'uploads' }), commands };
  }

  it('should set ContentType and Metadata on the put command', async () => {
    const { client, commands } = buildFakeS3();
    await client.put('avatars/ada.png', BYTES, PNG);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      Bucket: 'uploads',
      Key: 'avatars/ada.png',
      ContentType: 'image/png',
      Metadata: { owner: 'ada' },
    });
  });

  it('should OMIT both keys when no attributes are given', async () => {
    // Omitted, not `undefined`: an object stored with no explicit content type
    // must keep the backend's own default rather than an explicit empty one.
    const { client, commands } = buildFakeS3();
    await client.put('raw.bin', BYTES);

    expect('ContentType' in commands[0]!).toBe(false);
    expect('Metadata' in commands[0]!).toBe(false);
  });

  it('should carry a content type with no metadata, and the reverse', async () => {
    const { client, commands } = buildFakeS3();
    await client.put('a', BYTES, { contentType: 'text/plain' });
    await client.put('b', BYTES, { metadata: { k: 'v' } });

    expect(commands[0]).toMatchObject({ ContentType: 'text/plain' });
    expect('Metadata' in commands[0]!).toBe(false);
    expect(commands[1]).toMatchObject({ Metadata: { k: 'v' } });
    expect('ContentType' in commands[1]!).toBe(false);
  });
});

describe('GcsProvider — object attributes in the save options bag (X8-6)', () => {
  function buildFakeGcs() {
    const saves: { name: string; options: Record<string, unknown> }[] = [];
    const mod = {
      Storage: class {
        bucket(_name: string) {
          return {
            file(name: string) {
              return {
                save(
                  _data: Uint8Array,
                  options: Record<string, unknown>,
                  cb: (error: Error | null) => void,
                ) {
                  saves.push({ name, options });
                  cb(null);
                },
              };
            },
          };
        }
      },
    } as unknown as GcsSdkModule;
    const client = adaptGcsModule(mod, { bucket: 'uploads' });
    return { client, saves };
  }

  it('should pass contentType and metadata to save', async () => {
    const { client, saves } = buildFakeGcs();
    const file = (client.bucket() as {
      file(name: string): {
        save(
          data: Uint8Array,
          options: Record<string, unknown>,
          cb: (error: Error | null) => void,
        ): void;
      };
    }).file('avatars/ada.png');

    await new Promise<void>((resolve, reject) => {
      file.save(BYTES, { contentType: 'image/png', metadata: { owner: 'ada' } }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    expect(saves).toHaveLength(1);
    expect(saves[0]!.options).toEqual({
      contentType: 'image/png',
      metadata: { owner: 'ada' },
    });
  });
});

describe('AzureBlobProvider — content type inside blobHTTPHeaders (X8-6)', () => {
  /** Records the options every `uploadData` was called with. */
  function buildFakeAzure() {
    const uploads: Record<string, unknown>[] = [];
    const client = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          uploadData(_data: Uint8Array, options?: Record<string, unknown>): Promise<void> {
            uploads.push(options ?? {});
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as IAzureBlobClient;
    return { client, uploads };
  }

  it('should nest the content type under blobHTTPHeaders and keep metadata beside it', async () => {
    const { client, uploads } = buildFakeAzure();
    const provider = new AzureBlobProvider({ containerName: 'uploads', client }, () => 0);
    await provider.connect();

    await provider.put('avatars/ada.png', BYTES, PNG);

    expect(uploads[0]).toEqual({
      blobHTTPHeaders: { blobContentType: 'image/png' },
      metadata: { owner: 'ada' },
    });
  });

  it('should send an empty options bag when no attributes are given', async () => {
    const { client, uploads } = buildFakeAzure();
    const provider = new AzureBlobProvider({ containerName: 'uploads', client }, () => 0);
    await provider.connect();

    await provider.put('raw.bin', BYTES);

    expect(uploads[0]).toEqual({});
  });
});

describe('StorageService — forwarding to the provider (X8-6)', () => {
  /** A provider recording exactly how many arguments `put` received. */
  function recordingProvider() {
    const calls: { path: string; argc: number; options?: PutObjectOptions }[] = [];
    const provider = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      put(path: string, _data: Uint8Array, options?: PutObjectOptions): Promise<void> {
        calls.push({ path, argc: arguments.length, ...(options === undefined ? {} : { options }) });
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(false),
      exists: () => Promise.resolve(false),
      getSignedUrl: () => Promise.resolve(''),
    };
    return { provider, calls };
  }

  it('should forward the attributes verbatim', async () => {
    const { provider, calls } = recordingProvider();
    await new StorageService(provider).put('k', BYTES, PNG);

    expect(calls[0]!.options).toEqual(PNG);
  });

  it('should call the provider with TWO arguments when the caller omits them', async () => {
    // A provider must be able to tell "no attributes given" from "empty
    // attributes given" — passing `undefined` through would erase that.
    const { provider, calls } = recordingProvider();
    await new StorageService(provider).put('k', BYTES);

    expect(calls[0]!.argc).toBe(2);
  });
});

describe('memory and local providers — accepted and not persisted (X8-6)', () => {
  it('should store the bytes unchanged when memory is given attributes', async () => {
    const provider = new MemoryProvider(() => 0);
    await provider.connect();

    await provider.put('k', BYTES, PNG);

    expect(await provider.get('k')).toEqual(BYTES);
  });

  it('should store the bytes unchanged when local is given attributes', async () => {
    const written = new Map<string, Uint8Array>();
    const fs = {
      writeFile: (path: string, data: Uint8Array) => {
        written.set(path, data);
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      readFile: (path: string) => Promise.resolve(written.get(path) ?? new Uint8Array()),
      stat: () => Promise.resolve({ size: 0 }),
    } as unknown as IFileSystem;
    const provider = new LocalStorageProvider(fs, { rootDir: '/data' });
    await provider.connect();

    await provider.put('k.png', BYTES, PNG);

    expect([...written.values()][0]).toEqual(BYTES);
  });
});
