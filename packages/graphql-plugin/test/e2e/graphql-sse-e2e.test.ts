/**
 * E2E tests for the GraphQL-over-SSE transport over `app.fetch`.
 *
 * Exercises the distinct-connections mode: a POST to the SSE endpoint opens a
 * stream that carries `next` events (including in-stream validation errors per
 * the C4 protocol correction) and a `complete` terminator with its mandatory
 * empty `data:` field. Uses `app.fetch` rather than `inject()` because the
 * latter exposes no response headers — the M51 `Allow` lesson.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GraphqlPlugin } from '../../src/index.ts';

const decoder = new TextDecoder();

/**
 * Read a ReadableStream<Uint8Array> to a string, stopping once both a `data:`
 * frame and the `event: complete` terminator have been observed.
 */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  // Guard against a producer that never closes: stop once we have both frames.
  while (true) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 5000)
      ),
    ]);
    if (read.done) break;
    out += decoder.decode(read.value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return out;
}

describe('GraphQL SSE e2e (app.fetch)', () => {
  it('streams a single query result as next + complete', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

    const app = createApplication({
      plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} })],
    });
    await app.start({ port: 0 });

    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ hello }' }),
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.body).not.toBeNull();
      const body = await drainStream(res.body!);
      expect(body).toContain('"hello":"world"');
      expect(body).toContain('event: complete');
      expect(body).toContain('data: \n\n');
    } finally {
      await app.stop();
    }
  });

  it('emits a GraphQL request error as a next event inside the stream (C4)', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

    const app = createApplication({
      plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} })],
    });
    await app.start({ port: 0 });

    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ unknownField }' }),
        }),
      );

      // The stream opens with 200 even though the GraphQL request is invalid.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.body).not.toBeNull();
      const body = await drainStream(res.body!);
      // The error is carried inside the accepted stream as a `data:` event.
      expect(body).toContain('unknownField');
      expect(body).toContain('event: complete');
    } finally {
      await app.stop();
    }
  });

  it('GET streams a query result', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

    const app = createApplication({
      plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} })],
    });
    await app.start({ port: 0 });

    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream?query={hello}'),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.body).not.toBeNull();
      const body = await drainStream(res.body!);
      expect(body).toContain('"hello":"world"');
      expect(body).toContain('event: complete');
    } finally {
      await app.stop();
    }
  });

  it('GET with missing query returns a buffered 400 (transport failure)', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

    const app = createApplication({
      plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} })],
    });
    await app.start({ port: 0 });

    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream'),
      );

      // No query → transport failure, buffered HTTP error (no stream opened).
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = JSON.parse(await res.text()) as { errors?: Array<{ message?: string }> };
      expect(json.errors?.[0]?.message).toContain('Query parameter is required');
    } finally {
      await app.stop();
    }
  });
});
