/**
 * The `exists()` / `delete()` contract (V13-245), one table for every cloud
 * provider: `false` only for a definite not-found answer; an outage or a
 * refused credential rejects, classified; S3/B2 check with `HEAD` first, so an
 * absent key is `false` there too.
 *
 * Each provider is driven through its real adapter over a fake SDK module, so
 * the adapter's own handling is what is tested.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module, S3Provider } from '../../src/providers/s3-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';
import { adaptGcsModule, GcsProvider } from '../../src/providers/gcs-provider.ts';
import type { AzureSdkModule } from '../../src/providers/azure-provider.ts';
import { adaptAzureModule, AzureBlobProvider } from '../../src/providers/azure-provider.ts';

type Case = 'present' | 'absent' | 'outage' | 'refused';
type Expect = boolean | 'unavailable' | 'unknown' | 'named';

const outage = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });

/** The answer each SDK gives, per case. */
const AWS_FAULTS: Record<Exclude<Case, 'present'>, () => Error> = {
  absent: () =>
    Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
  outage,
  refused: () =>
    Object.assign(new Error('Forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    }),
};
const GCS_FAULTS: Record<Exclude<Case, 'present'>, () => Error> = {
  absent: () => Object.assign(new Error('No such object'), { code: 404 }),
  outage,
  refused: () => Object.assign(new Error('Forbidden'), { code: 403 }),
};
const AZURE_FAULTS: Record<Exclude<Case, 'present'>, () => Error> = {
  absent: () => Object.assign(new Error('BlobNotFound'), { statusCode: 404 }),
  outage,
  refused: () => Object.assign(new Error('AuthenticationFailed'), { statusCode: 403 }),
};

function s3Provider(c: Case): StorageProvider {
  const mod = {
    s3: {
      S3Client: class {
        send(command: { kind: string }): Promise<unknown> {
          // S3's DeleteObject answers 204 for an absent key.
          if (c === 'present' || (c === 'absent' && command.kind === 'delete')) {
            return Promise.resolve({});
          }
          return Promise.reject(AWS_FAULTS[c]());
        }
      },
      PutObjectCommand: class {
        kind = 'put';
      },
      GetObjectCommand: class {
        kind = 'get';
      },
      DeleteObjectCommand: class {
        kind = 'delete';
      },
      HeadObjectCommand: class {
        kind = 'head';
      },
    },
    presigner: { getSignedUrl: () => Promise.resolve('') },
  } as unknown as AwsStorageSdkModule;
  return new S3Provider({ bucket: 'b', client: adaptAwsS3Module(mod, { bucket: 'b' }) });
}

function gcsProvider(c: Case): StorageProvider {
  const answer = (cb: (err: Error | null) => void): void => {
    cb(c === 'present' ? null : GCS_FAULTS[c]());
  };
  const mod = {
    Storage: class {
      bucket(): unknown {
        return {
          file: () => ({
            getMetadata: (cb: (err: Error | null, m?: unknown) => void) => {
              answer((err) => cb(err, {}));
            },
            delete: answer,
          }),
          exists: () => Promise.resolve([true]),
        };
      }
    },
  } as unknown as GcsSdkModule;
  return new GcsProvider({ bucket: 'b', client: adaptGcsModule(mod, { bucket: 'b' }) });
}

function azureProvider(c: Case): StorageProvider {
  const blob = {
    getProperties: () =>
      c === 'present' ? Promise.resolve({}) : Promise.reject(AZURE_FAULTS[c]()),
    delete: () => (c === 'present' ? Promise.resolve({}) : Promise.reject(AZURE_FAULTS[c]())),
  };
  const service = {
    getContainerClient: () => ({ getBlockBlobClient: () => blob, exists: () => true }),
  };
  const mod = {
    BlobServiceClient: Object.assign(class {}, { fromConnectionString: () => service }),
    StorageSharedKeyCredential: class {},
  } as unknown as AzureSdkModule;
  const options = { containerName: 'c', connectionString: 'UseDevelopmentStorage=true' };
  return new AzureBlobProvider({ containerName: 'c', client: adaptAzureModule(mod, options) });
}

/** provider, factory, per case: [exists outcome, delete outcome]. */
const CONFORMANCE: readonly (readonly [
  string,
  (c: Case) => StorageProvider,
  Record<Case, readonly [Expect, Expect]>,
])[] = [
  [
    's3',
    s3Provider,
    {
      present: [true, true],
      absent: [false, false],
      outage: ['unavailable', 'unavailable'],
      refused: ['named', 'named'],
    },
  ],
  [
    'gcs',
    gcsProvider,
    {
      present: [true, true],
      absent: [false, false],
      // The client is injected (the adapter over a fake SDK), so a refused
      // delete has no attempt history: it may have landed, a 504.
      outage: ['unavailable', 'unknown'],
      refused: ['named', 'named'],
    },
  ],
  [
    'azure',
    azureProvider,
    {
      present: [true, true],
      absent: [false, false],
      // The client is injected (the adapter over a fake SDK), so a refused
      // delete has no attempt history: it may have landed, a 504.
      outage: ['unavailable', 'unknown'],
      refused: ['named', 'named'],
    },
  ],
];

async function outcome(run: () => Promise<boolean>): Promise<Expect> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BackendUnavailableError) return 'unavailable';
    if (error instanceof BackendOutcomeUnknownError) return 'unknown';
    if (error instanceof Error && /^storage-plugin \(\w+\): \w+ failed: /.test(error.message)) {
      return 'named';
    }
    throw error;
  }
}

describe('exists() and delete() conformance (V13-245)', () => {
  for (const [name, factory, cases] of CONFORMANCE) {
    for (const [c, [existsExpect, deleteExpect]] of Object.entries(cases) as [
      Case,
      readonly [Expect, Expect],
    ][]) {
      it(`${name}, ${c}: exists → ${String(existsExpect)}, delete → ${String(deleteExpect)}`, async () => {
        const provider = factory(c);
        await provider.connect();
        expect(await outcome(() => provider.exists('k'))).toBe(existsExpect);
        expect(await outcome(() => provider.delete('k'))).toBe(deleteExpect);
      });
    }
  }
});

describe('local provider: only an absent file is "not there" (V13-245)', () => {
  it('maps ENOENT and NotFound to false and rejects a permission error', async () => {
    const { LocalStorageProvider, isFsNotFound } =
      await import('../../src/providers/local-provider.ts');
    expect(isFsNotFound({ code: 'ENOENT' })).toBe(true);
    expect(isFsNotFound({ name: 'NotFound' })).toBe(true);
    expect(isFsNotFound({ code: 'EACCES' })).toBe(false);
    expect(isFsNotFound(null)).toBe(false);
    let fault: Error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fs = {
      stat: (path: string) => {
        if (path === '/root') return Promise.resolve({ size: 0 });
        return Promise.reject(fault);
      },
      rm: () => Promise.reject(fault),
      writeFile: () => Promise.resolve(),
      readFile: () => Promise.reject(fault),
      mkdir: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
    } as unknown as import('@setu-ts/common').IFileSystem;
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' }, () => 'node');
    await provider.connect();
    expect(await provider.exists('a.txt')).toBe(false);
    expect(await provider.delete('a.txt')).toBe(false);
    fault = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await expect(provider.exists('a.txt')).rejects.toThrow('EACCES');
    await expect(provider.delete('a.txt')).rejects.toThrow('EACCES');
  });
});

describe('local get: only an absent file is null (review fix)', () => {
  it('rejects a permission error instead of answering 404', async () => {
    const { LocalStorageProvider } = await import('../../src/providers/local-provider.ts');
    let fault: Error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fs = {
      stat: () => Promise.resolve({ size: 0 }),
      readFile: () => Promise.reject(fault),
      writeFile: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
    } as unknown as import('@setu-ts/common').IFileSystem;
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' }, () => 'node');
    await provider.connect();
    expect(await provider.get('a.txt')).toBeNull();
    fault = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await expect(provider.get('a.txt')).rejects.toThrow('EACCES');
  });
});
