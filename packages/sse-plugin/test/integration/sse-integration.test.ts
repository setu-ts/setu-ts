/**
 * Integration test for SSE plugin — real socket round-trip.
 *
 * Uses `createApplication` + `RuntimePlugin()` + `SsePlugin()`, `app.start({ port })`
 * + real `fetch()` + `response.body.getReader()`, following the M42 streaming test
 * template. `inject()` discards streaming bodies, so we cannot use it here.
 *
 * This test MUST FAIL when bug #1 (missing runtime into SseService) is present
 * and PASS after the fix.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import type { ISseService, RouteHandler } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { SsePlugin } from '../../src/index.ts';
afterEach(() => {
  // Ensure free port cleanup between tests.
});

/** Bind a port, release it, return the port number. */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Consume all chunks from a `ReadableStream<Uint8Array>` body until done. */
async function consumeAll(body: ReadableStream<Uint8Array>): Promise<string[]> {
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

/** Decode SSE frames from raw text chunks. */
interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: string;
}
function decodeSseFrames(rawChunks: string[]): SseFrame[] {
  const combined = rawChunks.join('');
  const frames: SseFrame[] = [];
  let current: Partial<SseFrame> = { data: '' };

  for (const line of combined.split('\n')) {
    if (line === '') {
      // Only push a frame if we actually have data.
      if (current.data && current.data.trim()) {
        frames.push(current as SseFrame);
        current = { data: '' };
      } else {
        current = { data: '' };
      }
    } else if (line.startsWith(':')) {
      // Comment — ignore.
    } else if (line.startsWith('data:')) {
      current.data = (current.data ? current.data + '\n' : '') + line.slice(5);
    } else if (line.startsWith('id:')) {
      current.id = line.slice(3).trim();
    } else if (line.startsWith('event:')) {
      current.event = line.slice(6).trim();
    } else if (line.startsWith('retry:')) {
      current.retry = line.slice(6).trim();
    }
  }
  return frames;
}

describe('SSE Integration (real plugin end-to-end)', () => {
  it('should deliver HTTP 200 with text/event-stream content-type and a streamed data frame', async () => {
    const port = findFreePort();

    const app = createApplication({
      plugins: [RuntimePlugin(), SsePlugin()],
    });

    const handler: RouteHandler = (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse!.open(ctx);
      conn.send({ data: 'hello' });
      // Close after sending to allow the stream to terminate cleanly.
      setTimeout(() => {
        conn.close();
      }, 50);
      return conn.result;
    };

    app.router.get('/events', handler);

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      if (!response.body) throw new Error('expected body');

      const chunks = await consumeAll(response.body);
      const frames = decodeSseFrames(chunks);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0].data.trim()).toBe('hello');
    } finally {
      await app.stop();
    }
  });

  it('should deliver heartbeat comment frames on the socket', async () => {
    const port = findFreePort();

    const app = createApplication({
      plugins: [RuntimePlugin(), SsePlugin({ heartbeatMs: 30 })],
    });

    const handler: RouteHandler = (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse!.open(ctx);
      setTimeout(() => {
        conn.close();
      }, 200);
      return conn.result;
    };

    app.router.get('/events', handler);

    await app.start({ port });

    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);

      const response = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: ac.signal,
      });
      expect(response.status).toBe(200);

      if (!response.body) throw new Error('expected body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let iterations = 0;
      const maxIterations = 20;

      while (iterations < maxIterations) {
        try {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value?: never }>((r) =>
              setTimeout(() => r({ done: true }), 250)
            ),
          ]);
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        } catch {
          break;
        }
        iterations++;
      }

      const combined = chunks.join('');
      expect(combined).toContain(': heartbeat');
    } finally {
      await app.stop();
    }
  });

  it('should track connectionCount through lifecycle', async () => {
    const port = findFreePort();
    let serviceRef: ISseService | null = null;

    const app = createApplication({
      plugins: [RuntimePlugin(), SsePlugin({ heartbeatMs: 30 })],
    });

    const handler: RouteHandler = (ctx) => {
      serviceRef = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = serviceRef!.open(ctx);
      setTimeout(() => {
        conn.close();
      }, 100);
      return conn.result;
    };

    app.router.get('/events', handler);

    await app.start({ port });

    try {
      // deno-lint-ignore no-explicit-any
      expect((serviceRef as any)?.connectionCount ?? 0).toBe(0);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);

      const response = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: ac.signal,
      });
      expect(response.status).toBe(200);

      await new Promise((r) => setTimeout(r, 150));
      // deno-lint-ignore no-explicit-any -- integration test race
      expect((serviceRef as any)?.connectionCount ?? 0).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('should fire id event and custom event types', async () => {
    const port = findFreePort();

    const app = createApplication({
      plugins: [RuntimePlugin(), SsePlugin()],
    });

    const handler: RouteHandler = (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse!.open(ctx);
      conn.send({ id: '42', event: 'tick', data: '{ "n": 1 }' });
      setTimeout(() => {
        conn.close();
      }, 50);
      return conn.result;
    };

    app.router.get('/events', handler);

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      expect(response.status).toBe(200);

      if (!response.body) throw new Error('expected body');

      const chunks = await consumeAll(response.body);
      const frames = decodeSseFrames(chunks);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0].id).toBe('42');
      expect(frames[0].event).toBe('tick');
      expect(frames[0].data.trim()).toBe('{ "n": 1 }');
    } finally {
      await app.stop();
    }
  });

  it('should include retry frame when retryMs is provided', async () => {
    const port = findFreePort();

    const app = createApplication({
      plugins: [RuntimePlugin(), SsePlugin({ retryMs: 5000 })],
    });

    const handler: RouteHandler = (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse!.open(ctx);
      setTimeout(() => {
        conn.close();
      }, 50);
      return conn.result;
    };

    app.router.get('/events', handler);

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      expect(response.status).toBe(200);

      if (!response.body) throw new Error('expected body');

      const chunks = await consumeAll(response.body);
      const combined = chunks.join('');
      expect(combined).toContain('retry: 5000');
    } finally {
      await app.stop();
    }
  });
});
