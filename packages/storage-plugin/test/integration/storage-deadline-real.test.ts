/**
 * Every cloud storage arm ends within `requestTimeoutMs` (V13-216), and a GCS
 * download answered 502/503 rejects instead of ending the process (V13-235).
 *
 * Driven through the REAL SDKs (`@aws-sdk/client-s3`, `@google-cloud/storage`,
 * `@azure/storage-blob`, all devDependencies) against in-test servers: one that
 * accepts a connection and never answers, and one that answers every request
 * with a 502 or 503 in Google's JSON error shape.
 *
 * @module
 */
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  httpStatusHintOf,
} from '@setu-ts/common';
import { S3Provider } from '../../src/providers/s3-provider.ts';
import { GcsProvider } from '../../src/providers/gcs-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';

const BOUND_MS = 300;
const SLACK_MS = 5000;

let blackHole: NetServer;
let blackHolePort = 0;
const sockets = new Set<Socket>();
let failing: HttpServer;
let failingPort = 0;
let failingStatus = 503;

beforeAll(async () => {
  blackHole = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
  blackHolePort = (blackHole.address() as { port: number }).port;
  failing = createHttpServer((_req, res) => {
    res.writeHead(failingStatus, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: failingStatus, message: 'Backend unavailable', errors: [] },
      }),
    );
  });
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
  failingPort = (failing.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
  await new Promise<void>((resolve) => failing.close(() => resolve()));
});

/** Runs a call, returning the rejection and how long it took. */
async function timed(run: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const started = performance.now();
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  return { error, ms: performance.now() - started };
}

function expectBounded(
  result: { error: unknown; ms: number },
  cls: typeof BackendUnavailableError | typeof BackendOutcomeUnknownError,
): void {
  expect(result.error).toBeInstanceOf(cls);
  expect(result.ms).toBeLessThan(BOUND_MS + SLACK_MS);
}

describe('requestTimeoutMs bounds every call on the real SDKs (V13-216)', () => {
  it('s3: a read is a 503 and a write a 504 within the bound', async () => {
    const provider = new S3Provider({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: `http://127.0.0.1:${blackHolePort}`,
      requestTimeoutMs: BOUND_MS,
    });
    await provider.connect();
    expectBounded(await timed(() => provider.get('k')), BackendUnavailableError);
    expectBounded(await timed(() => provider.exists('k')), BackendUnavailableError);
    expectBounded(
      await timed(() => provider.put('k', new Uint8Array([1]))),
      BackendOutcomeUnknownError,
    );
    // S3's delete checks presence first; a hang there is a read (nothing sent).
    expectBounded(await timed(() => provider.delete('k')), BackendUnavailableError);
  });

  it('gcs: a read is a 503 and a write a 504 within the bound', async () => {
    const provider = new GcsProvider(
      {
        bucket: 'b',
        projectId: 'p',
        endpoint: `http://127.0.0.1:${blackHolePort}`,
        endpointAuth: false,
        requestTimeoutMs: BOUND_MS,
      },
      undefined,
      undefined,
      {},
    );
    await provider.connect();
    expectBounded(await timed(() => provider.exists('k')), BackendUnavailableError);
    expectBounded(await timed(() => provider.getStream('k')), BackendUnavailableError);
    expectBounded(
      await timed(() => provider.put('k', new Uint8Array([1]))),
      BackendOutcomeUnknownError,
    );
  });

  it('azure: a read is a 503 and a write a 504 within the bound', async () => {
    const provider = new AzureBlobProvider({
      containerName: 'c',
      connectionString:
        'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
        'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
        `BlobEndpoint=http://127.0.0.1:${blackHolePort}/devstoreaccount1;`,
      requestTimeoutMs: BOUND_MS,
    });
    await provider.connect();
    expectBounded(await timed(() => provider.exists('k')), BackendUnavailableError);
    expectBounded(await timed(() => provider.get('k')), BackendUnavailableError);
    expectBounded(await timed(() => provider.delete('k')), BackendOutcomeUnknownError);
  });

  it('a directly constructed provider refuses an out-of-range bound', () => {
    expect(() => new S3Provider({ bucket: 'b', requestTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => new GcsProvider({ bucket: 'b', requestTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(
      () => new AzureBlobProvider({ containerName: 'c', requestTimeoutMs: 2_147_483_648 }),
    ).toThrow(RangeError);
  });
});

describe('gcs: a 502 or 503 on a download rejects and the process lives (V13-235)', () => {
  for (const status of [502, 503]) {
    it(`get, getStream and exists answer a 503-class error for a backend ${status}`, async () => {
      failingStatus = status;
      const provider = new GcsProvider(
        {
          bucket: 'b',
          projectId: 'p',
          endpoint: `http://127.0.0.1:${failingPort}`,
          endpointAuth: false,
          requestTimeoutMs: 10_000,
        },
        undefined,
        undefined,
        {},
      );
      await provider.connect();
      // Before the fix the SDK's retry path rejected unhandled with
      // ERR_STREAM_UNABLE_TO_PIPE, which ends the process and fails this run.
      for (const run of [() => provider.get('k'), () => provider.getStream('k')]) {
        const error = await run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BackendUnavailableError);
        expect(httpStatusHintOf(error)?.status).toBe(503);
      }
      expect(await provider.exists('k').catch((e: unknown) => e)).toBeInstanceOf(
        BackendUnavailableError,
      );
      // Give a stray unhandled rejection a turn to surface before the next case.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  }
});
