/**
 * One `delete()` answer on every provider (maintainer decision 2026-11-22):
 * deleting an absent key resolves `false`, deleting a present key resolves
 * `true` and the key is gone. An application tested on memory gets the same
 * answer deployed on S3, B2, GCS or Azure.
 *
 * The table drives memory and local directly, and S3/B2, GCS and Azure through
 * their real adapters over stateful fake SDK modules; the guarded
 * `cloud-standin.test.ts` runs the same steps against MinIO, fake-gcs-server
 * and Azurite. Not driven here: Cloudflare R2 (`@setu-ts/cloudflare-plugin`,
 * another package, which already checks first).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IFileSystem } from '@setu-ts/common';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { LocalStorageProvider } from '../../src/providers/local-provider.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module, S3Provider } from '../../src/providers/s3-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import { adaptGcsModule, GcsProvider } from '../../src/providers/gcs-provider.ts';
import type { AzureSdkModule } from '../../src/providers/azure-provider.ts';
import { adaptAzureModule, AzureBlobProvider } from '../../src/providers/azure-provider.ts';

const notFound = (shape: Record<string, unknown>): Error =>
  Object.assign(new Error('not found'), shape);

function memory(): StorageProvider {
  return new MemoryProvider(() => 0);
}

function local(): StorageProvider {
  const files = new Map<string, Uint8Array>();
  const enoent = (): Error => notFound({ code: 'ENOENT' });
  const fs = {
    stat: (path: string) =>
      path === '/root' || files.has(path) ? Promise.resolve({ size: 0 }) : Promise.reject(enoent()),
    readFile: (path: string) => {
      const data = files.get(path);
      return data === undefined ? Promise.reject(enoent()) : Promise.resolve(data);
    },
    writeFile: (path: string, data: Uint8Array) => {
      files.set(path, data);
      return Promise.resolve();
    },
    rm: (path: string) => (files.delete(path) ? Promise.resolve() : Promise.reject(enoent())),
    mkdir: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
  } as unknown as IFileSystem;
  return new LocalStorageProvider(fs, { rootDir: '/root' }, () => 'node');
}

function s3(): StorageProvider {
  const objects = new Map<string, Uint8Array>();
  class Command {
    constructor(readonly input: { Key: string; Body?: Uint8Array }) {}
  }
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class HeadObjectCommand extends Command {}
  const mod = {
    s3: {
      S3Client: class {
        send(command: Command): Promise<unknown> {
          const key = command.input.Key;
          if (command instanceof PutObjectCommand) objects.set(key, command.input.Body!);
          else if (command instanceof DeleteObjectCommand)
            objects.delete(key); // 204 either way
          else if (!objects.has(key)) {
            return Promise.reject(
              notFound({ name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
            );
          }
          return Promise.resolve({ Body: objects.get(key) });
        }
      },
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
      HeadObjectCommand,
    },
    presigner: { getSignedUrl: () => Promise.resolve('') },
  } as unknown as AwsStorageSdkModule;
  return new S3Provider({ bucket: 'b', client: adaptAwsS3Module(mod, { bucket: 'b' }) });
}

function gcs(): StorageProvider {
  const objects = new Map<string, Uint8Array>();
  const mod = {
    Storage: class {
      bucket(): unknown {
        return {
          file: (name: string) => ({
            save: (data: Uint8Array, _o: unknown, cb: (e: Error | null) => void) => {
              objects.set(name, data);
              cb(null);
            },
            getMetadata: (cb: (e: Error | null, m?: unknown) => void) => {
              cb(objects.has(name) ? null : notFound({ code: 404 }), {});
            },
            delete: (cb: (e: Error | null) => void) => {
              cb(objects.delete(name) ? null : notFound({ code: 404 }));
            },
          }),
        };
      }
    },
  } as unknown as GcsSdkModule;
  return new GcsProvider({ bucket: 'b', client: adaptGcsModule(mod, { bucket: 'b' }) });
}

function azure(): StorageProvider {
  const objects = new Map<string, Uint8Array>();
  const service = {
    getContainerClient: () => ({
      getBlockBlobClient: (name: string) => ({
        uploadData: (data: Uint8Array) => {
          objects.set(name, data);
          return Promise.resolve({});
        },
        exists: () => Promise.resolve(objects.has(name)),
        delete: () =>
          objects.delete(name)
            ? Promise.resolve({})
            : Promise.reject(notFound({ statusCode: 404 })),
      }),
    }),
  };
  const mod = {
    BlobServiceClient: Object.assign(class {}, { fromConnectionString: () => service }),
    StorageSharedKeyCredential: class {},
  } as unknown as AzureSdkModule;
  const options = { containerName: 'c', connectionString: 'UseDevelopmentStorage=true' };
  return new AzureBlobProvider({ containerName: 'c', client: adaptAzureModule(mod, options) });
}

const PROVIDERS: readonly (readonly [string, () => StorageProvider])[] = [
  ['memory', memory],
  ['local', local],
  ['s3 / b2', s3],
  ['gcs', gcs],
  ['azure', azure],
];

describe('delete() answers the same on every provider', () => {
  for (const [name, factory] of PROVIDERS) {
    it(`${name}: absent → false; present → true, then gone`, async () => {
      const provider = factory();
      await provider.connect();
      expect(await provider.delete('a.txt')).toBe(false);
      await provider.put('a.txt', new Uint8Array([1]));
      expect(await provider.exists('a.txt')).toBe(true);
      expect(await provider.delete('a.txt')).toBe(true);
      expect(await provider.exists('a.txt')).toBe(false);
      expect(await provider.delete('a.txt')).toBe(false);
    });
  }
});
