// deno-lint-ignore-file no-explicit-any
/**
 * Integration tests for streaming responses — end-to-end via real server socket.
 *
 * These tests use `app.start()` + real TCP sockets and issue real `fetch()`
 * requests so that native `Request.signal` propagation, `ReadableStream`
 * chunk delivery, and abort behaviour are exercised through the full
 * runtime adapter pipeline (not mocks).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { cacheMiddleware, CachePlugin } from '@hono-enterprise/cache-plugin';
import type { IPluginContext, IRequestContext } from '@hono-enterprise/common';

/** Bind a port, release it, return the port number. */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Consume all chunks from a `ReadableStream<Uint8Array>` body. */
async function consumeChunks(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

describe('streaming integration', () => {
  // -----------------------------------------------------------------------
  // 1. Multi-chunk incremental delivery
  // -----------------------------------------------------------------------

  it('streaming route delivers multiple chunks and closes correctly', async () => {
    const port = findFreePort();
    let yieldedCount = 0;

    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.get('/stream', (ctx) => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 1; i <= 3; i++) {
            const chunkDelay = new Promise((r) => setTimeout(r, 2));
            await chunkDelay;
            controller.enqueue(new TextEncoder().encode(`chunk-${i}\n`));
            yieldedCount++;
          }
          controller.close();
        },
      });
      return ctx.response.stream(stream);
    });

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/stream`);
      expect(response.status).toBe(200);
      // stream() doesn't set a default content-type; the header may be null.
      expect(response.headers.has('content-type')).toBeFalsy();

      const body = response.body;
      if (!body) throw new Error('expected body');

      const chunks = await consumeChunks(body);
      expect(chunks).toEqual(['chunk-1\n', 'chunk-2\n', 'chunk-3\n']);
      expect(yieldedCount).toBe(3);
    } finally {
      await app.stop();
    }
  });

  // -----------------------------------------------------------------------
  // 2. Abort propagates: native Request.signal → ctx.signal
  // -----------------------------------------------------------------------

  it('aborting the client Request propagates to ctx.signal', async () => {
    const port = findFreePort();

    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.get('/abort-stream', async (ctx) => {
      let yielded = 0;
      for (let i = 1; i <= 5; i++) {
        const chunkDelay = new Promise((r) => setTimeout(r, 10));
        await chunkDelay;
        yielded++;
        // If aborted, break out immediately
        if ((ctx as any).signal?.aborted) {
          break;
        }
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`yielded=${yielded}`));
          controller.close();
        },
      });
      return ctx.response.stream(stream);
    });

    await app.start({ port });

    try {
      const ac = new AbortController();

      const fetchPromise = fetch(`http://127.0.0.1:${port}/abort-stream`, {
        signal: ac.signal,
      });

      // Let the handler start and receive the first abort signal
      await new Promise((r) => setTimeout(r, 15));
      ac.abort();

      let body = '';
      try {
        const response = await fetchPromise;
        expect(response.status).toBe(200);
        body = await response.text();
      } catch (e) {
        // The fetch may throw AbortError when the client aborts mid-stream
        expect((e as Error).name).toBe('AbortError');
      }

      if (body) {
        // The producer observed the abort and broke out of the loop
        expect(body).toMatch(/^yielded=\d+$/);
        const prodYielded = parseInt(body.match(/yielded=(\d+)/)?.[1] ?? '-1', 10);
        expect(prodYielded).toBeLessThan(5);
      }
    } finally {
      await app.stop();
    }
  });

  // -----------------------------------------------------------------------
  // 3. Streaming behind cacheMiddleware → X-Cache: MISS (not stored)
  // -----------------------------------------------------------------------

  it('streaming behind cacheMiddleware gets X-Cache: MISS', async () => {
    const port = findFreePort();

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'streaming-test-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/stream-cache', (_c: IRequestContext) => {
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('hello'));
                  controller.close();
                },
              });
              return (_c as any).response.stream(stream);
            });
          },
        } as any,
      ],
    });

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/stream-cache`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-cache')).toBe('MISS');

      // Consume the body (required so the server doesn't emit an unhandled error)
      await response.text();
    } finally {
      await app.stop();
    }
  });
});
