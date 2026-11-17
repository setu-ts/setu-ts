/**
 * A fresh full-stack application refuses an oversized body on the wire, both
 * declared (`Content-Length`) and chunked (no length: only the read can bound
 * it). Before the starter default, both were parsed in full.
 */
import { request } from 'node:http';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import type { IKernelApplication } from '@setu-ts/kernel';
import { createFullStackApp } from '../../src/app.ts';
import { createFullStackAppFromConfig } from '../../src/from-config.ts';

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** POSTs `bytes` of JSON, declared or chunked, and returns status and body. */
function post(
  port: number,
  bytes: number,
  chunked: boolean,
): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify({ blob: 'x'.repeat(bytes - 12) }));
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = request(
      {
        // A fresh connection per request: a server that refused a body it did
        // not read closes that connection, and a pooled socket would carry the
        // next request into the reset.
        agent: false,
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/echo-size',
        headers: chunked
          ? { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
          : { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    // A server that answers 413 early may close before the whole body is
    // written. Once the response has arrived that reset is expected; before
    // it, it is a failure.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (responded && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) return;
      reject(error);
    });
    if (chunked) {
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        req.write(payload.subarray(offset, offset + 64 * 1024));
      }
    } else {
      req.write(payload);
    }
    req.end();
  });
}

const builders: readonly [string, () => Promise<IKernelApplication>][] = [
  ['createFullStackApp', () => Promise.resolve(createFullStackApp())],
  ['createFullStackAppFromConfig', () => createFullStackAppFromConfig(() => ({}), { env: {} })],
];

describe('full-stack starter body limit on the wire', () => {
  for (const [name, build] of builders) {
    it(`refuses a 2 MiB body, declared or chunked, and accepts 512 KiB (${name})`, async () => {
      const app = await build();
      app.router.post('/api/echo-size', async (ctx) => {
        const body = await ctx.request.json<{ blob: string }>();
        return ctx.response.json({ length: body.blob.length });
      });
      const port = await unusedPort();
      await app.start({ port, hostname: '127.0.0.1' });
      try {
        const declared = await post(port, 2 * 1_048_576, false);
        expect(declared.status).toBe(413);
        const problem = JSON.parse(declared.body) as Record<string, unknown>;
        expect(problem['status']).toBe(413);
        expect(problem).toHaveProperty('title');
        expect(problem).toHaveProperty('detail');
        expect(problem).not.toHaveProperty('message');

        expect((await post(port, 2 * 1_048_576, true)).status).toBe(413);

        const small = await post(port, 512 * 1024, true);
        expect(small.status).toBe(200);
        expect(JSON.parse(small.body)).toEqual({ length: 512 * 1024 - 12 });
        expect((await post(port, 512 * 1024, false)).status).toBe(200);
      } finally {
        await app.stop();
      }
    });
  }

  it('honours a raised runtime.maxBodyBytes for both paths', async () => {
    const app = createFullStackApp({ runtime: { maxBodyBytes: 4 * 1_048_576 } });
    app.router.post('/api/echo-size', async (ctx) => {
      const body = await ctx.request.json<{ blob: string }>();
      return ctx.response.json({ length: body.blob.length });
    });
    const port = await unusedPort();
    await app.start({ port, hostname: '127.0.0.1' });
    try {
      expect((await post(port, 2 * 1_048_576, false)).status).toBe(200);
      expect((await post(port, 2 * 1_048_576, true)).status).toBe(200);
      expect((await post(port, 5 * 1_048_576, true)).status).toBe(413);
    } finally {
      await app.stop();
    }
  });
});
