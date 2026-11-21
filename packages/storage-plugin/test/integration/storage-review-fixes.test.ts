/**
 * Review fixes on the real SDKs: a body that stalls after its headers is still
 * bounded on S3 and Azure (V13-216), and the `b2` arm with only an endpoint
 * signs with that endpoint's region (V13-248).
 *
 * @module
 */
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { S3Provider } from '../../src/providers/s3-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { b2RegionFromEndpoint, createProvider } from '../../src/plugin/storage-plugin.ts';

let server: Server;
let port = 0;
const authorizations: string[] = [];
const stalled = new Set<ServerResponse>();
let closed = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    authorizations.push(String(req.headers.authorization ?? ''));
    // Headers and the first byte of a 1 MiB body, then nothing.
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(1 << 20),
      etag: '"x"',
      'last-modified': new Date(0).toUTCString(),
      'x-ms-blob-type': 'BlockBlob',
    });
    res.write('a');
    stalled.add(res);
    res.on('close', () => {
      closed++;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const res of stalled) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function expectBounded(run: () => Promise<unknown>): Promise<void> {
  const before = closed;
  const started = performance.now();
  await expect(run()).rejects.toBeInstanceOf(BackendUnavailableError);
  expect(performance.now() - started).toBeLessThan(5000);
  // The stalled body is destroyed, so the connection is released.
  for (let i = 0; i < 40 && closed === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(closed).toBeGreaterThan(before);
}

describe('a body that stalls after its headers is bounded (V13-216)', () => {
  it('s3 get', async () => {
    const provider = new S3Provider({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 400,
    });
    await provider.connect();
    await expectBounded(() => provider.get('k'));
  });

  it('azure get', async () => {
    const provider = new AzureBlobProvider({
      containerName: 'c',
      connectionString:
        'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
        'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
        `BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`,
      requestTimeoutMs: 400,
    });
    await provider.connect();
    await expectBounded(() => provider.get('k'));
  });
});

describe('b2 with only an endpoint (V13-248)', () => {
  const runtime = {
    now: () => 0,
    hrtime: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  } as unknown as IRuntimeServices;

  it('signs with us-east-1 for a non-Backblaze endpoint, and sends', async () => {
    authorizations.length = 0;
    const provider = createProvider(
      {
        provider: 'b2',
        options: {
          bucket: 'b',
          accessKeyId: 'k',
          secretAccessKey: 's',
          endpoint: `http://127.0.0.1:${port}`,
          requestTimeoutMs: 400,
        },
      },
      runtime,
    );
    await provider.connect();
    await provider.get('k').catch(() => undefined);
    expect(authorizations[0]).toMatch(/\/us-east-1\/s3\/aws4_request/);
  });

  it('b2RegionFromEndpoint reads an exact Backblaze host only', () => {
    for (const [endpoint, region] of [
      ['https://s3.us-west-004.backblazeb2.com', 'us-west-004'],
      ['https://S3.US-WEST-004.BACKBLAZEB2.COM/', 'us-west-004'],
      ['https://s3.us-west-004.backblazeb2.com.example.net', undefined],
      ['http://127.0.0.1:9000', undefined],
      ['not a url', undefined],
      [undefined, undefined],
    ] as const) {
      expect(b2RegionFromEndpoint(endpoint)).toBe(region);
    }
  });

  it('reads the region from a Backblaze endpoint', () => {
    // Built, not sent: the Backblaze host is not reachable from the test.
    const provider = createProvider(
      {
        provider: 'b2',
        options: { bucket: 'b', endpoint: 'https://s3.us-west-004.backblazeb2.com' },
      },
      runtime,
    );
    expect(provider).toBeInstanceOf(S3Provider);
  });
});
