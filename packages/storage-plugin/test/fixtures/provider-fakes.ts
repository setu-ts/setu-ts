/**
 * Stateful fakes of every storage provider: memory and local directly, S3/B2,
 * GCS and Azure through their real adapters over fake SDK modules. Shared by
 * the delete-consistency and storage-key tables.
 *
 * @module
 */
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

export function memory(): StorageProvider {
  return new MemoryProvider(() => 0);
}

export function local(): StorageProvider {
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

export function s3(): StorageProvider {
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

export function gcs(): StorageProvider {
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

export function azure(): StorageProvider {
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

/** Every provider, by name. */
export const PROVIDERS: readonly (readonly [string, () => StorageProvider])[] = [
  ['memory', memory],
  ['local', local],
  ['s3 / b2', s3],
  ['gcs', gcs],
  ['azure', azure],
];
