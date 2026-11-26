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
import type { AwsStorageSdkModule } from '../../src/providers/s3-provider.ts';
import { adaptAwsS3Module, S3Provider } from '../../src/providers/s3-provider.ts';
import { PROVIDERS } from '../fixtures/provider-fakes.ts';

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

describe('S3 delete: presence check edge cases', () => {
  function provider(head: () => Promise<unknown>, deleted: string[]): S3Provider {
    class Command {
      constructor(readonly input: { Key: string }) {}
    }
    class HeadObjectCommand extends Command {}
    class DeleteObjectCommand extends Command {}
    const mod = {
      s3: {
        S3Client: class {
          send(command: Command): Promise<unknown> {
            if (command instanceof HeadObjectCommand) return head();
            deleted.push(command.input.Key);
            return Promise.resolve({});
          }
        },
        PutObjectCommand: Command,
        GetObjectCommand: Command,
        DeleteObjectCommand,
        HeadObjectCommand,
      },
      presigner: { getSignedUrl: () => Promise.resolve('') },
    } as unknown as AwsStorageSdkModule;
    return new S3Provider({
      bucket: 'b',
      requestTimeoutMs: 200,
      client: adaptAwsS3Module(mod, { bucket: 'b' }),
    });
  }

  it('a 403 on the check (no s3:ListBucket) still deletes and answers true', async () => {
    const deleted: string[] = [];
    const p = provider(
      () =>
        Promise.reject(
          Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } }),
        ),
      deleted,
    );
    await p.connect();
    expect(await p.delete('k')).toBe(true);
    expect(deleted).toEqual(['k']);
  });

  it('a timeout during the check is a 503 and nothing is deleted', async () => {
    const { BackendUnavailableError } = await import('@setu-ts/common');
    const deleted: string[] = [];
    const p = provider(() => new Promise(() => undefined), deleted);
    await p.connect();
    await expect(p.delete('k')).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(deleted).toEqual([]);
  });
});
