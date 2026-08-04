/**
 * E2E tests for REAL GraphQL subscriptions.
 *
 * Every other subscription test in this package drives either a fake runtime
 * or a fake `IGraphqlService`, and the two transport e2e files declare a
 * Query-only schema — so a `subscribe` frame there executes a QUERY. That gap
 * is why the schema-first arm shipped unable to serve a subscription at all:
 * `attachResolvers` assigned the `{ subscribe }` entry to the field's
 * `resolve`, leaving `subscribe` unset, and `graphql.subscribe()` threw
 * "Subscription field must return Async Iterable. Received: undefined."
 *
 * These tests declare a real `type Subscription`, resolve it through the real
 * `npm:graphql@^16`, and read the events off the wire.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IGraphqlService, IWebSocketService } from '@hono-enterprise/common';
import { GraphqlPlugin } from '../../src/index.ts';
import type { ResolverMap } from '../../src/index.ts';
import {
  encodeFrame,
  GQL_COMPLETE,
  GQL_CONNECTION_ACK,
  GQL_CONNECTION_INIT,
  GQL_NEXT,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

const decoder = new TextDecoder();

/** A secret an internal error would carry if masking were skipped. */
const SECRET = 'postgres://admin:hunter2@db.internal:5432';

const typeDefs = `
  type Query { hello: String }
  type Subscription { tick: Int, boom: Int }
`;

/**
 * Declared as `ResolverMap` WITHOUT a cast — the type has to admit a
 * subscription resolver, which it did not before. The shipped integration test
 * needed `resolvers as never` to compile.
 */
const resolvers: ResolverMap = {
  Query: { hello: () => 'world' },
  Subscription: {
    tick: {
      subscribe: () =>
        (async function* () {
          yield { tick: 1 };
          yield { tick: 2 };
        })(),
      resolve: (payload) => (payload as { tick: number }).tick,
    },
    // Streams one good event, then a resolver failure carrying internals.
    boom: {
      subscribe: () =>
        (async function* () {
          yield { boom: 1 };
          yield { boom: 2 };
        })(),
      resolve: (payload) => {
        if ((payload as { boom: number }).boom === 2) {
          throw new Error(SECRET);
        }
        return 1;
      },
    },
  },
};

function buildApp(extraPlugins: ReturnType<typeof WebSocketPlugin>[] = []) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...extraPlugins,
      // maskInternalErrors is left at its DEFAULT (true).
      GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} }),
    ],
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let out = '';
  while (true) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 5000)
      ),
    ]);
    if (read.done) break;
    out += decoder.decode(read.value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch { /* already closed */ }
  return out;
}

describe('GraphQL real subscriptions (schema-first)', () => {
  it('service.subscribe returns a live stream for a schema-first subscription', async () => {
    const app = buildApp();
    await app.start({ port: 0 });
    try {
      const service = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
      const outcome = await service.subscribe({ query: 'subscription { tick }' });

      // Before the fix this threw
      // "Subscription field must return Async Iterable. Received: undefined."
      expect(outcome.kind).toBe('stream');
      if (outcome.kind !== 'stream') return;

      const seen: unknown[] = [];
      for await (const event of outcome.stream) {
        seen.push(event);
      }
      expect(seen).toEqual([{ data: { tick: 1 } }, { data: { tick: 2 } }]);
    } finally {
      await app.stop();
    }
  });

  it('streams a schema-first subscription over SSE as next … next … complete', async () => {
    const app = buildApp();
    await app.start({ port: 0 });
    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'subscription { tick }' }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const body = await drain(res.body!);
      expect(body).toContain('event: next\ndata: {"data":{"tick":1}}');
      expect(body).toContain('event: next\ndata: {"data":{"tick":2}}');
      expect(body.endsWith('event: complete\ndata: \n\n')).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('masks an internal error raised inside a LIVE subscription, exactly as HTTP does', async () => {
    const app = buildApp();
    await app.start({ port: 0 });
    try {
      // The subscription path.
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'subscription { boom }' }),
        }),
      );
      const body = await drain(res.body!);

      // The regression: before the fix the raw connection string reached the
      // subscriber while the HTTP path masked the identical error.
      expect(body).not.toContain(SECRET);
      expect(body).toContain('Internal server error');
      expect(body).toContain('INTERNAL_SERVER_ERROR');
      // The good event still arrives ahead of the masked one.
      expect(body).toContain('"boom":1');
    } finally {
      await app.stop();
    }
  });

  it('streams a schema-first subscription over a real WebSocket', async () => {
    const app = buildApp([WebSocketPlugin()]);
    const listener = Deno.listen({ port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    await app.start({ port });

    try {
      const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
      expect(ws.available).toBe(true);

      const client = new WebSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
      const frames: string[] = [];
      const done = Promise.withResolvers<void>();

      client.onmessage = (ev) => {
        frames.push(String(ev.data));
        if (String(ev.data).includes(GQL_COMPLETE)) {
          done.resolve();
        }
      };
      await new Promise<void>((resolve) => {
        client.onopen = () => resolve();
      });

      client.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
      client.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: 'sub-1',
        payload: { query: 'subscription { tick }' },
      }));

      await Promise.race([
        done.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      client.close();

      const joined = frames.join('\n');
      expect(joined).toContain(GQL_CONNECTION_ACK);
      // Two real subscription events, then the terminator — a Query-only
      // schema could only ever produce one `next`.
      expect(joined).toContain('"tick":1');
      expect(joined).toContain('"tick":2');
      expect(frames.filter((f) => f.includes(`"type":"${GQL_NEXT}"`)).length).toBe(2);
      expect(joined).toContain(GQL_COMPLETE);
    } finally {
      await app.stop();
    }
  });
});
