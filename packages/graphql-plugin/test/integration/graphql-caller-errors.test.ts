/**
 * Caller errors a resolver throws keep their meaning on every transport.
 *
 * A `notFound()` from `@setu-ts/exceptions` or a 4xx status hint reaches the
 * client with a GraphQL code and its caller-safe text, as `errorHandler`
 * serves it on REST; a 5xx stays masked. The masker is shared, so the same
 * table is driven over HTTP, SSE and WebSocket.
 */

import { describe, expect, it } from 'vitest';
import { withHttpStatusHint } from '@setu-ts/common';
import { forbidden, internalServerError, notFound } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { unusedPort } from '../../../../test/node-helpers.ts';
import { GraphqlPlugin } from '../../src/index.ts';
import {
  encodeFrame,
  GQL_CONNECTION_INIT,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

/** Field → what its resolver throws → what the client must see. */
const CASES = [
  {
    field: 'a',
    thrown: () => notFound('Order 42 not found'),
    code: 'NOT_FOUND',
    message: 'Order 42 not found',
  },
  {
    field: 'b',
    thrown: () => forbidden('Not your order'),
    code: 'FORBIDDEN',
    message: 'Not your order',
  },
  {
    field: 'c',
    thrown: () =>
      withHttpStatusHint(new Error('db detail'), {
        status: 404,
        title: 'Not Found',
        detail: 'No such order',
      }),
    code: 'NOT_FOUND',
    message: 'No such order',
  },
  {
    field: 'd',
    thrown: () => internalServerError('db password=x'),
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
  },
] as const;

const QUERY = `{ ${CASES.map((c) => c.field).join(' ')} }`;

interface WireError {
  message: string;
  path?: string[];
  extensions?: { code?: string };
}

function makeApp(extra: 'ws' | 'none') {
  const resolvers = {
    Query: Object.fromEntries(
      CASES.map((c) => [
        c.field,
        () => {
          throw c.thrown();
        },
      ]),
    ),
  };
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...(extra === 'ws' ? [WebSocketPlugin()] : []),
      GraphqlPlugin({
        typeDefs: `type Query { ${CASES.map((c) => `${c.field}: String`).join(' ')} }`,
        resolvers,
        subscriptions: extra === 'ws' ? {} : { websocket: false },
      }),
    ],
  });
}

/** Asserts the four errors, keyed by field path, and that nothing leaked. */
function expectCallerErrors(errors: readonly WireError[], raw: string): void {
  for (const c of CASES) {
    const error = errors.find((e) => e.path?.[0] === c.field);
    expect(error?.extensions?.code).toBe(c.code);
    expect(error?.message).toBe(c.message);
  }
  expect(raw).not.toContain('db detail');
  expect(raw).not.toContain('password');
}

describe('caller errors from a resolver keep their meaning', () => {
  it('over HTTP', async () => {
    const app = makeApp('none');
    await app.start();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY }),
      });
      const raw = String(res.body);
      expectCallerErrors((JSON.parse(raw) as { errors: WireError[] }).errors, raw);
    } finally {
      await app.stop();
    }
  });

  it('over SSE', async () => {
    const app = makeApp('none');
    await app.start();
    try {
      const res = await app.fetch(
        new Request('http://localhost/graphql/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ query: QUERY }),
        }),
      );
      const raw = await res.text();
      const data = raw
        .split('\n')
        .find((line) => line.startsWith('data: {'))
        ?.slice('data: '.length);
      expectCallerErrors((JSON.parse(data ?? '{}') as { errors: WireError[] }).errors, raw);
    } finally {
      await app.stop();
    }
  });

  it('over WebSocket', async () => {
    const app = makeApp('ws');
    const port = await unusedPort();
    await app.start({ port });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
      const inbox: string[] = [];
      const next = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for next')), 5000);
        client.addEventListener('message', (event) => {
          const value = String(event.data);
          inbox.push(value);
          if (value.includes('"type":"next"')) {
            clearTimeout(timer);
            resolve(value);
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error('socket errored before opening'));
      });
      try {
        client.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
        client.send(encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: QUERY } }));
        const raw = await next;
        const frame = JSON.parse(raw) as { payload: { errors: WireError[] } };
        expectCallerErrors(frame.payload.errors, inbox.join('\n'));
      } finally {
        client.close();
      }
    } finally {
      await app.stop();
    }
  });
});
