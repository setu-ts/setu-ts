/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for Deno HTTP adapter — REAL round-trip with Deno.serve.
 *
 * These tests bind a real OS socket and issue real fetch requests.
 * They require the `net` permission to be granted.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { DenoHttpAdapter } from '../../src/adapters/deno/deno-http-adapter.ts';

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
});
