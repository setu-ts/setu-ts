import { unusedPort } from '../../../../test/node-helpers.ts';
/**
 * Content-type parity through the real Node adapter.
 *
 * `@hono/node-server` writes `text/plain; charset=UTF-8` for any response body
 * that carries no `content-type`. The Fetch standard implies a type only for a
 * string body, so a byte or stream body labelled as text on Node only is a
 * runtime divergence. These cases drive a real socket so node-server's own
 * header writing is what is observed.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes(text));
      controller.close();
    },
  });
}

describe('Node adapter content-type parity', () => {
  // Only `stream()` writes a body with no type of its own; `send`, `text` and
  // `json` set one, which must reach the client unchanged.
  it('adds no type to an untyped stream and keeps every explicit type', async () => {
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.router.get('/stream', (ctx) => ctx.response.stream(stream('s')));
    app.router.get('/bytes', (ctx) => ctx.response.send(bytes('b')));
    app.router.get('/text', (ctx) => ctx.response.text('t'));
    app.router.get(
      '/typed-stream',
      (ctx) => ctx.response.header('content-type', 'application/x-ndjson').stream(stream('{}')),
    );
    app.router.get('/json', (ctx) => ctx.response.json({ ok: true }));
    await app.start({ port });

    try {
      const types: Record<string, string | null> = {};
      const bodies: Record<string, string> = {};
      for (const path of ['stream', 'bytes', 'text', 'typed-stream', 'json']) {
        const response = await fetch(`http://127.0.0.1:${port}/${path}`);
        types[path] = response.headers.get('content-type');
        bodies[path] = await response.text();
      }
      expect(types).toEqual({
        stream: null,
        bytes: 'application/octet-stream',
        text: 'text/plain; charset=utf-8',
        'typed-stream': 'application/x-ndjson',
        json: 'application/json; charset=utf-8',
      });
      expect(bodies).toEqual({
        stream: 's',
        bytes: 'b',
        text: 't',
        'typed-stream': '{}',
        json: '{"ok":true}',
      });
    } finally {
      await app.stop();
    }
  });
});
