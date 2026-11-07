/**
 * Cross-site requests cannot run a mutation on either GraphQL route.
 *
 * A browser sends a CORS "simple" request — a POST whose media type is
 * `text/plain`, urlencoded or multipart, parameters allowed, or a GET —
 * cross-site with no preflight, and attaches cookies subject to `SameSite`. A
 * top-level GET navigation carries even `SameSite=Lax` cookies. Each case below
 * ran the mutation before this fix; the counter, asserted BEFORE the status,
 * proves it no longer does.
 *
 * `app.fetch` is used because `inject()` cannot read an SSE stream.
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GraphqlPlugin } from '../../src/index.ts';

/** Every no-preflight POST media type, plus a POST with no `content-type`. */
const SIMPLE_TYPES: ReadonlyArray<string | null> = [
  null,
  'text/plain',
  'text/plain; x=application/json',
  'application/x-www-form-urlencoded',
  'application/x-www-form-urlencoded; a=application/json',
  'multipart/form-data; boundary=x; a=application/json',
];

const ROUTES = ['http://localhost/graphql', 'http://localhost/graphql/stream'] as const;

const MUTATION = JSON.stringify({ query: 'mutation { transfer }' });

async function appWithCounter() {
  const state = { calls: 0 };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      GraphqlPlugin({
        typeDefs: `
          type Query { a: String }
          type Mutation { transfer: Int }
          type Subscription { tick: Int }
        `,
        resolvers: {
          Query: { a: () => 'x' },
          Mutation: { transfer: () => ++state.calls },
          Subscription: {
            tick: {
              subscribe: () =>
                (async function* () {
                  yield { tick: 1 };
                })(),
            },
          },
        },
        subscriptions: { websocket: false },
      }),
    ],
  });
  await app.start();
  return { app, state };
}

/** A POST with the given `content-type`; a Blob body sets none for `null`. */
function post(url: string, type: string | null): Request {
  return new Request(url, {
    method: 'POST',
    headers: type === null ? {} : { 'content-type': type },
    body: type === null ? new Blob([MUTATION]) : MUTATION,
  });
}

describe('a cross-site simple request cannot run a mutation', () => {
  for (const url of ROUTES) {
    for (const type of SIMPLE_TYPES) {
      it(`POST ${new URL(url).pathname} refuses ${String(type)} with 415`, async () => {
        const { app, state } = await appWithCounter();
        try {
          const res = await app.fetch(post(url, type));
          await res.text();
          expect(state.calls).toBe(0);
          expect(res.status).toBe(415);
        } finally {
          await app.stop();
        }
      });
    }
  }

  it('GET /graphql/stream refuses a mutation with 405 and Allow: POST', async () => {
    const { app, state } = await appWithCounter();
    try {
      const query = encodeURIComponent('mutation { transfer }');
      const res = await app.fetch(
        new Request(`http://localhost/graphql/stream?query=${query}`, {
          headers: { accept: 'text/event-stream' },
        }),
      );
      await res.text();
      expect(state.calls).toBe(0);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    } finally {
      await app.stop();
    }
  });

  it('HEAD /graphql/stream does not run a mutation', async () => {
    const { app, state } = await appWithCounter();
    try {
      const query = encodeURIComponent('mutation { transfer }');
      const res = await app.fetch(
        new Request(`http://localhost/graphql/stream?query=${query}`, { method: 'HEAD' }),
      );
      await res.text();
      expect(state.calls).toBe(0);
      expect(res.ok).toBe(false);
    } finally {
      await app.stop();
    }
  });
});

describe('the legitimate requests still run', () => {
  it('application/json with a charset runs the mutation on both routes', async () => {
    const { app, state } = await appWithCounter();
    try {
      for (const url of ROUTES) {
        const res = await app.fetch(post(url, 'application/json; charset=utf-8'));
        await res.text();
        expect(res.status).toBe(200);
      }
      expect(state.calls).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('an SSE GET query and an SSE GET subscription still stream', async () => {
    const { app } = await appWithCounter();
    try {
      for (const [document, data] of [
        ['{ a }', '{"a":"x"}'],
        ['subscription { tick }', '{"tick":1}'],
      ] as const) {
        const res = await app.fetch(
          new Request(`http://localhost/graphql/stream?query=${encodeURIComponent(document)}`, {
            headers: { accept: 'text/event-stream' },
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(await res.text()).toContain(`"data":${data}`);
      }
    } finally {
      await app.stop();
    }
  });
});
