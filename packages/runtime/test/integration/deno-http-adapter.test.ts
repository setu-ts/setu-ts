/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for Deno HTTP adapter — REAL round-trip with Deno.serve.
 *
 * These tests bind a real OS socket and issue real fetch requests.
 * They require the `net` permission to be granted.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DenoHttpAdapter } from '../../src/adapters/deno/deno-http-adapter.ts';

const TLS_DIR = new URL('../fixtures/tls/', import.meta.url);

describe('deno-http-adapter integration', () => {
  it('real socket round-trip with known port', async () => {
    const port = 18765;

    const adapter = new DenoHttpAdapter();

    // eslint-disable-next-line require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: 'deno-integration-ok',
        }),
      } as any;
    });

    const handle = await adapter.listen(port, '127.0.0.1');

    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain');
      const body = await response.text();
      expect(body).toBe('deno-integration-ok');
    } finally {
      await adapter.close(handle);
    }

    // After close, the socket should be released — try re-binding
    const adapter2 = new DenoHttpAdapter();
    // eslint-disable-next-line require-await
    adapter2.setHandler(async (_request) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'rebound',
        }),
      } as any;
    });
    const handle2 = await adapter2.listen(port, '127.0.0.1');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`);
      expect(response.status).toBe(200);
    } finally {
      await adapter2.close(handle2);
    }
  });

  it('serves TLS from http2 { key, cert } and stamps the listener scheme (M139b)', async () => {
    const key = await readFile(new URL('localhost-key.pem', TLS_DIR), 'utf8');
    const cert = await readFile(new URL('localhost-cert.pem', TLS_DIR), 'utf8');
    const adapter = new DenoHttpAdapter(undefined, { http2: { key, cert } });
    // eslint-disable-next-line require-await
    adapter.setHandler(async (request) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: new URL(request.url).protocol,
        }),
      } as any;
    });
    const handle = await adapter.listen(18766, '127.0.0.1');
    const client = Deno.createHttpClient({ caCerts: [cert] });
    try {
      const response = await fetch('https://127.0.0.1:18766/scheme', { client });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('https:');
    } finally {
      client.close();
      await adapter.close(handle);
    }
  });
});
