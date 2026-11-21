/**
 * The GCS, Azure and S3 arms against local stand-ins, through the REAL SDKs:
 * upload, download, exists, delete and a signed URL fetched back; an outage is
 * a 503 and a refused credential a provider-named error.
 *
 * Each block is guarded on its stand-in's variable and skips without it:
 *
 * - `GCS_EMULATOR_URL` — fake-gcs-server (`fsouza/fake-gcs-server`, `-scheme http`)
 * - `AZURITE_CONNECTION_STRING` — Azurite's blob service
 * - `S3_ENDPOINT_URL` — MinIO (keys `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`,
 *   default `minioadmin`)
 *
 * A stand-in run proves the arm against the stand-in only; no live cloud
 * account was used.
 *
 * @module
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '@setu-ts/common';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { GcsProvider } from '../../src/providers/gcs-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { S3Provider } from '../../src/providers/s3-provider.ts';

const GCS = process.env['GCS_EMULATOR_URL'];
const AZURITE = process.env['AZURITE_CONNECTION_STRING'];
const S3 = process.env['S3_ENDPOINT_URL'];
const NOW = (): number => performance.timeOrigin + performance.now();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const unique = (): string => `standin-${Math.floor(performance.now() * 1000)}`;

/** Upload, read back by both paths, exists, delete, exists again. */
async function roundTrip(provider: StorageProvider, key: string): Promise<void> {
  const body = encoder.encode(`hello ${key}`);
  await provider.put(key, body, { contentType: 'text/plain' });
  expect(decoder.decode((await provider.get(key))!)).toBe(`hello ${key}`);
  const stream = await provider.getStream!(key);
  const chunks: number[] = [];
  for await (const chunk of stream!) chunks.push(...chunk);
  expect(decoder.decode(new Uint8Array(chunks))).toBe(`hello ${key}`);
  expect(await provider.exists(key)).toBe(true);
  expect(await provider.delete(key)).toBe(true);
  expect(await provider.exists(key)).toBe(false);
  expect(await provider.get(key)).toBeNull();
  expect(await provider.getStream!(key)).toBeNull();
}

describe.skipIf(GCS === undefined)('gcs on fake-gcs-server', () => {
  it('round-trips through the endpoint option (V13-248) and reports absent as absent (V13-245)', async () => {
    const bucket = unique();
    const created = await fetch(`${GCS}/storage/v1/b?project=p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
    });
    expect(created.ok).toBe(true);
    const provider = new GcsProvider(
      { bucket, projectId: 'p', endpoint: GCS, endpointAuth: false },
      NOW,
    );
    await provider.connect();
    await roundTrip(provider, 'docs/a.txt');
    expect(await provider.delete('docs/a.txt')).toBe(false);
    expect(await provider.isHealthy!()).toBe(true);
  });

  it('signs a URL that expires in the future (V13-234)', async () => {
    const bucket = unique();
    await fetch(`${GCS}/storage/v1/b?project=p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
    });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), 'gcs-key-'));
    const keyFile = join(dir, 'key.json');
    writeFileSync(
      keyFile,
      JSON.stringify({
        type: 'service_account',
        project_id: 'p',
        client_email: 'signer@p.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    );
    const previous = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] = keyFile;
    try {
      const provider = new GcsProvider(
        { bucket, projectId: 'p', endpoint: GCS, endpointAuth: false },
        NOW,
      );
      await provider.connect();
      await provider.put('signed.txt', encoder.encode('signed body'), {
        contentType: 'text/plain',
      });
      const before = Date.now();
      const url = new URL(await provider.getSignedUrl('signed.txt', { expiresIn: 300 }));
      // The SDK signs V2 by default: `Expires` is the expiry in epoch seconds,
      // and the URL is on the endpoint's own host.
      const expires = Number(url.searchParams.get('Expires')) * 1000;
      expect(expires).toBeGreaterThan(before + 299_000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 301_000);
      expect(url.origin).toBe(new URL(GCS!).origin);
      // fake-gcs-server checks no signature, so this proves the path and query
      // the SDK built, not that Google would accept the signature.
      const answer = await fetch(url);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('signed body');
    } finally {
      if (previous === undefined) delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      else process.env['GOOGLE_APPLICATION_CREDENTIALS'] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreachable endpoint is a 503 and the probe reads down', async () => {
    const provider = new GcsProvider(
      { bucket: 'b', projectId: 'p', endpoint: 'http://127.0.0.1:1', endpointAuth: false },
      NOW,
    );
    await provider.connect();
    await expect(provider.exists('k')).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(await provider.isHealthy!()).toBe(false);
  });
});

describe.skipIf(AZURITE === undefined)('azure on Azurite', () => {
  async function container(): Promise<string> {
    const name = unique().toLowerCase();
    const { BlobServiceClient } = await import('@azure/storage-blob');
    await BlobServiceClient.fromConnectionString(AZURITE!).getContainerClient(name).create();
    return name;
  }

  function accountFrom(cs: string): { name: string; key: string; endpoint: string } {
    const part = (field: string): string => new RegExp(`${field}=([^;]+)`).exec(cs)![1]!;
    return { name: part('AccountName'), key: part('AccountKey'), endpoint: part('BlobEndpoint') };
  }

  it('starts from a connection string and round-trips (V13-233)', async () => {
    const containerName = await container();
    const provider = new AzureBlobProvider({ containerName, connectionString: AZURITE }, NOW);
    await provider.connect();
    await roundTrip(provider, 'docs/a.txt');
    expect(await provider.delete('docs/a.txt')).toBe(false);
    expect(await provider.isHealthy!()).toBe(true);
  });

  it('starts from accountName/accountKey with an endpoint, and signs an encoded SAS URL', async () => {
    const containerName = await container();
    const account = accountFrom(AZURITE!);
    const provider = new AzureBlobProvider(
      {
        containerName,
        accountName: account.name,
        accountKey: account.key,
        endpoint: account.endpoint,
      },
      NOW,
    );
    await provider.connect();
    const key = 'docs/a b/ñ#1?.txt';
    await provider.put(key, encoder.encode('sas body'), { contentType: 'text/plain' });
    const url = await provider.getSignedUrl(key, { expiresIn: 300 });
    expect(url.startsWith(account.endpoint)).toBe(true);
    expect(url).toContain('a%20b/%C3%B1%231%3F.txt');
    const answer = await fetch(url);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('sas body');
  });

  it('works with an injected SDK BlobServiceClient (V13-233)', async () => {
    const containerName = await container();
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const client = BlobServiceClient.fromConnectionString(AZURITE!);
    const provider = new AzureBlobProvider({ containerName, client }, NOW);
    await provider.connect();
    await roundTrip(provider, 'injected.txt');
    await provider.put('injected-sas.txt', encoder.encode('x'));
    expect(
      (await fetch(await provider.getSignedUrl('injected-sas.txt', { expiresIn: 60 }))).status,
    ).toBe(200);
  });

  it('a refused credential is a provider-named error; an unreachable endpoint a 503', async () => {
    const containerName = await container();
    const account = accountFrom(AZURITE!);
    const wrongKey = new AzureBlobProvider(
      {
        containerName,
        accountName: account.name,
        accountKey: Buffer.from('not-the-key').toString('base64'),
        endpoint: account.endpoint,
      },
      NOW,
    );
    await wrongKey.connect();
    await expect(wrongKey.exists('k')).rejects.toThrow(/^storage-plugin \(azure\): exists failed/);
    const unreachable = new AzureBlobProvider(
      {
        containerName,
        accountName: account.name,
        accountKey: account.key,
        endpoint: 'http://127.0.0.1:1/devstoreaccount1',
        // The Azure SDK retries a refused connection with backoff, so an outage
        // answers when the bound fires; a short bound keeps this test quick.
        requestTimeoutMs: 1500,
      },
      NOW,
    );
    await unreachable.connect();
    await expect(unreachable.exists('k')).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(await unreachable.isHealthy!()).toBe(false);
  });
});

describe.skipIf(S3 === undefined)('s3 on MinIO', () => {
  const accessKeyId = process.env['S3_ACCESS_KEY_ID'] ?? 'minioadmin';
  const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY'] ?? 'minioadmin';

  async function bucket(): Promise<string> {
    const name = unique();
    const mod = await import('@aws-sdk/client-s3');
    const client = new mod.S3Client({
      region: 'us-east-1',
      endpoint: S3!,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await client.send(new mod.CreateBucketCommand({ Bucket: name }));
    return name;
  }

  it('round-trips; delete of an absent key is false, exists false (V13-245)', async () => {
    const provider = new S3Provider({
      bucket: await bucket(),
      region: 'us-east-1',
      endpoint: S3,
      accessKeyId,
      secretAccessKey,
    });
    await provider.connect();
    await roundTrip(provider, 'docs/a.txt');
    expect(await provider.delete('docs/a.txt')).toBe(false);
    await provider.put('signed.txt', encoder.encode('presigned'));
    expect(
      await (await fetch(await provider.getSignedUrl('signed.txt', { expiresIn: 60 }))).text(),
    ).toBe('presigned');
  });

  it('a refused credential is a provider-named error; an unreachable endpoint a 503', async () => {
    const name = await bucket();
    const wrong = new S3Provider({
      bucket: name,
      region: 'us-east-1',
      endpoint: S3,
      accessKeyId,
      secretAccessKey: 'wrong-secret',
    });
    await wrong.connect();
    await expect(wrong.exists('k')).rejects.toThrow(/^storage-plugin \(s3\): exists failed/);
    await expect(wrong.delete('k')).rejects.toThrow(/^storage-plugin \(s3\): delete failed/);
    const unreachable = new S3Provider({
      bucket: name,
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      accessKeyId,
      secretAccessKey,
    });
    await unreachable.connect();
    await expect(unreachable.exists('k')).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe.skipIf(AZURITE === undefined)(
  'azure on Azurite: a traversing key cannot reach another container',
  () => {
    it('get and getSignedUrl of ../<other>/secret.txt are refused', async () => {
      const { BlobServiceClient } = await import('@azure/storage-blob');
      const service = BlobServiceClient.fromConnectionString(AZURITE!);
      const mine = unique().toLowerCase();
      const other = `${mine}-other`;
      await service.getContainerClient(mine).create();
      await service.getContainerClient(other).create();
      await service
        .getContainerClient(other)
        .getBlockBlobClient('secret.txt')
        .upload('tenant-b', 8);
      const provider = new AzureBlobProvider(
        { containerName: mine, connectionString: AZURITE },
        NOW,
      );
      await provider.connect();
      await expect(provider.get(`../${other}/secret.txt`)).rejects.toThrow(/segment/);
      await expect(
        provider.getSignedUrl(`../${other}/secret.txt`, { expiresIn: 60 }),
      ).rejects.toThrow(/segment/);
    });
  },
);
