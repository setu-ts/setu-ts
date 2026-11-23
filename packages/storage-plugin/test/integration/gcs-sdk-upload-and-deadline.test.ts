import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '@setu-ts/common';
import { adaptGcsModule, GcsProvider } from '../../src/providers/gcs-provider.ts';
import type { GcsSdkModule } from '../../src/providers/gcs-provider.ts';

describe('real GCS SDK upload authentication', () => {
  for (const endpointAuth of [true, false]) {
    it(`Authorization on POST /upload with endpointAuth=${endpointAuth}`, async () => {
      const { Storage, CRC32C } = await import('@google-cloud/storage');
      const checksum = new CRC32C();
      checksum.update(Buffer.from([1]));
      const auth = new Storage().authClient.fromJSON({
        type: 'authorized_user',
        client_id: 'capture',
        client_secret: 'capture',
        refresh_token: 'capture',
      });
      auth.setCredentials({ access_token: 'capture-token', expiry_date: 4_000_000_000_000 });
      const requests: { method: string; url: string; authorization: string | undefined }[] = [];
      const server = createServer((req, res) => {
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
        });
        req.resume();
        req.on('end', () => {
          if (req.method === 'POST' && req.url?.includes('uploadType=resumable') === true) {
            res.writeHead(200, {
              location: `http://127.0.0.1:${(server.address() as { port: number }).port}/session`,
              'content-type': 'application/json',
            });
            res.end('{}');
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ name: 'k', bucket: 'b', size: '1', crc32c: checksum.toString() }),
            );
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const options = {
          bucket: 'b',
          projectId: 'p',
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          endpointAuth,
        };
        const mod = {
          Storage: class {
            constructor(config: Record<string, unknown>) {
              return new Storage({ ...config, authClient: auth });
            }
          },
        } as unknown as GcsSdkModule;
        const provider = new GcsProvider({ ...options, client: adaptGcsModule(mod, options) });
        await provider.connect();
        await provider.put('k', new Uint8Array([1]));
        const post = requests.find(
          (req) => req.method === 'POST' && req.url.startsWith('/upload/'),
        );
        expect(post).toBeDefined();
        expect(post?.authorization).toBe(endpointAuth ? 'Bearer capture-token' : undefined);
        await provider.disconnect();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});

describe('real GCS SDK drip download stops at its deadline', () => {
  it('closes the server socket while it is still dripping bytes', async () => {
    let mediaRequests = 0;
    let closedAt: number | undefined;
    const server = createServer((req, res) => {
      if (req.url?.includes('alt=media')) {
        mediaRequests++;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(new Uint8Array(10));
        const drip = setInterval(() => res.write(new Uint8Array(10)), 25);
        res.once('close', () => {
          clearInterval(drip);
          closedAt = performance.now();
        });
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'k', bucket: 'b', size: '1000', generation: '1' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const provider = new GcsProvider({
        bucket: 'b',
        projectId: 'p',
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        endpointAuth: false,
        requestTimeoutMs: 200,
      });
      await provider.connect();
      const started = performance.now();
      await expect(provider.get('k')).rejects.toBeInstanceOf(BackendUnavailableError);
      for (let i = 0; i < 20 && closedAt === undefined; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mediaRequests).toBe(1);
      expect(closedAt).toBeDefined();
      expect(closedAt! - started).toBeLessThan(600);
      await provider.disconnect();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
