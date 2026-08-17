import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAwsS3Client } from '../../../src/interfaces/index.ts';
import { S3Provider } from '../../../src/providers/s3-provider.ts';

interface HeadBehavior {
  ok: boolean;
  calls: string[];
}

function makeClient(ok: boolean): { client: IAwsS3Client; behavior: HeadBehavior } {
  const behavior: HeadBehavior = { ok, calls: [] };
  const client: Record<string, unknown> = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(false),
    getSignedUrl: () => Promise.resolve('https://signed'),
    getStream: () => Promise.resolve(null),
    head: (path: string) => {
      behavior.calls.push(path);
      return Promise.resolve(ok);
    },
  };
  return { client: client as unknown as IAwsS3Client, behavior };
}

describe('S3Provider health (M70c)', () => {
  it('is reachable when the bucket answers head', async () => {
    const { client, behavior } = makeClient(true);
    const provider = new S3Provider({ bucket: 'b', client });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
    // The bucket probe uses the existing head member with an empty key.
    expect(behavior.calls).toEqual(['']);
  });

  it('is unreachable when head reports the bucket missing', async () => {
    const { client } = makeClient(false);
    const provider = new S3Provider({ bucket: 'b', client });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable before connect (no client yet)', async () => {
    const provider = new S3Provider({ bucket: 'b', client: makeClient(true).client });
    expect(provider.isReady()).toBe(false);
    expect(await provider.isHealthy()).toBe(false);
  });
});
