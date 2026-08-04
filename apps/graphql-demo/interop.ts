// deno-lint-ignore-file no-console -- this is a runnable report, not library
// code; its whole output is the result table an operator reads.
/**
 * Interop checks against REAL third-party GraphQL clients.
 *
 * The point of this file is that nothing here is hand-rolled. The in-repo test
 * suite drives our own frame codec against our own state machine, which cannot
 * tell us whether a conformant client agrees with us. So:
 *
 *   - `npm:graphql-ws` is the reference implementation of the protocol the
 *     plugin hand-writes, and is therefore the authority on conformance.
 *   - `@apollo/client`'s persisted-query link defines the APQ handshake
 *     `PUBLIC_API.md` claims to interoperate with.
 *
 * Every run boots its own application on an ephemeral port, so the APQ cache
 * starts COLD. That matters more than it looks: with a warm cache the Apollo
 * checks pass without the miss→retry handshake ever executing, which is a
 * result that looks identical to a real one. The persisted-query check
 * therefore asserts the WIRE SEQUENCE, not just the final data — a warm cache
 * fails it.
 *
 * ```
 * deno task interop
 * ```
 *
 * @module
 */

import { createClient } from 'npm:graphql-ws@^6.0.0';
import {
  ApolloClient,
  gql,
  HttpLink,
  InMemoryCache,
} from 'npm:@apollo/client@^3.13.0/core/index.js';
import { createPersistedQueryLink } from 'npm:@apollo/client@^3.13.0/link/persisted-queries/index.js';
import { sha256 } from 'npm:js-sha256@^0.11.0';
import { createDemoApp, freePort } from './src/app.ts';
import { INTERNAL_SECRET } from './src/schema.ts';

const results: { ok: boolean; label: string; detail: string }[] = [];

function check(ok: boolean, label: string, detail = ''): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

/** Waits for a condition, so no check depends on a fixed sleep. */
async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const port = freePort();
const app = createDemoApp();
await app.start({ port });
const http = `http://localhost:${port}/graphql`;

try {
  // ── graphql-ws, the reference client ──────────────────────────────────────
  console.log('\ngraphql-ws reference client (npm:graphql-ws@6)');

  const ws = createClient({
    url: `ws://localhost:${port}/graphql/ws`,
    webSocketImpl: WebSocket,
    connectionParams: { authorization: 'demo-token' },
    retryAttempts: 0,
  });

  const ticks: number[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.subscribe<{ countdown: number }>({ query: 'subscription { countdown(from: 3) }' }, {
      next: (d) => void (d.data && ticks.push(d.data.countdown)),
      error: reject,
      complete: resolve,
    });
    setTimeout(() => reject(new Error('timed out')), 10_000);
  });
  check(
    JSON.stringify(ticks) === '[3,2,1,0]',
    'a subscription streams every event, then completes',
    `received ${JSON.stringify(ticks)}`,
  );

  const queryOverSocket = await new Promise<unknown>((resolve, reject) => {
    let data: unknown;
    ws.subscribe<Record<string, unknown>>({ query: '{ hello }' }, {
      next: (d) => void (data = d.data),
      error: reject,
      complete: () => resolve(data),
    });
    setTimeout(() => reject(new Error('timed out')), 10_000);
  });
  check(
    JSON.stringify(queryOverSocket) === '{"hello":"world"}',
    'a query over the same socket answers next then complete',
    JSON.stringify(queryOverSocket),
  );

  const maskedOverSocket = await new Promise<string>((resolve, reject) => {
    let text = '';
    ws.subscribe<Record<string, unknown>>({ query: '{ boom }' }, {
      next: (d) => void (text = JSON.stringify(d)),
      error: (e: unknown) => resolve(JSON.stringify(e)),
      complete: () => resolve(text),
    });
    setTimeout(() => reject(new Error('timed out')), 10_000);
  });
  check(
    !maskedOverSocket.includes(INTERNAL_SECRET) &&
      maskedOverSocket.includes('Internal server error'),
    'an internal error is masked on the socket, as it is over HTTP',
    maskedOverSocket.slice(0, 100),
  );

  const pushed: string[] = [];
  const stop = ws.subscribe<{ bookAdded: { title: string } }>(
    { query: 'subscription { bookAdded { title } }' },
    {
      next: (d) => void (d.data && pushed.push(d.data.bookAdded.title)),
      error: () => {},
      complete: () => {},
    },
  );
  // The subscription has to be established before the mutation fires.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fetch(http, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation { addBook(title: "Roadside Picnic", author: "Strugatsky") { id } }',
    }),
  });
  await until(() => pushed.length > 0);
  stop();
  check(
    pushed.includes('Roadside Picnic'),
    'a mutation on the HTTP transport reaches a subscriber on the socket',
    JSON.stringify(pushed),
  );

  await ws.dispose();

  // ── Apollo Client, automatic persisted queries ────────────────────────────
  console.log('\nApollo Client persisted queries (npm:@apollo/client@3)');

  // Record what the link actually puts on the wire. The sequence is the
  // assertion: guessing at Apollo's document normalisation to recompute the
  // hash locally produces a different digest and a false failure.
  const wire: { sentDocument: boolean; hash: string | undefined }[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    try {
      const body = JSON.parse(String(init?.body ?? '{}'));
      wire.push({
        sentDocument: typeof body.query === 'string',
        hash: body.extensions?.persistedQuery?.sha256Hash,
      });
    } catch {
      // Not a JSON body; nothing to record.
    }
    return fetch(input, init);
  };

  const apollo = new ApolloClient({
    cache: new InMemoryCache(),
    link: createPersistedQueryLink({ sha256: (body: string) => sha256(body) })
      .concat(new HttpLink({ uri: http, fetch: recordingFetch })),
  });

  const query = gql`{ books { title } }`;
  const first = await apollo.query({ query, fetchPolicy: 'no-cache' });
  const second = await apollo.query({ query, fetchPolicy: 'no-cache' });

  check(
    Array.isArray(first.data?.books) && Array.isArray(second.data?.books),
    'both requests return data through the persisted-query link',
    `${first.data?.books?.length} books`,
  );

  const shape = wire.map((w) => (w.sentDocument ? 'document' : 'hash-only'));
  const oneHash = new Set(wire.map((w) => w.hash)).size === 1 && wire[0]?.hash !== undefined;
  check(
    JSON.stringify(shape) === '["hash-only","document","hash-only"]' && oneHash,
    'the miss → retry → hit handshake actually executed',
    `wire: ${JSON.stringify(shape)}, single hash: ${oneHash}`,
  );

  // Replay Apollo's own hash with no document at all.
  const apolloHash = wire[0]?.hash ?? '';
  const replay = await (await fetch(http, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      extensions: { persistedQuery: { version: 1, sha256Hash: apolloHash } },
    }),
  })).json();
  check(
    replay.data?.books !== undefined,
    'a bare hash with no document is served from the APQ cache',
    JSON.stringify(replay).slice(0, 90),
  );

  const poisoned = await (await fetch(http, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: '{ books { author } }',
      extensions: { persistedQuery: { version: 1, sha256Hash: apolloHash } },
    }),
  })).json();
  check(
    poisoned.errors?.[0]?.extensions?.code === 'PERSISTED_QUERY_HASH_MISMATCH',
    'a document that does not match its hash is refused, so the cache cannot be poisoned',
    poisoned.errors?.[0]?.extensions?.code ?? JSON.stringify(poisoned).slice(0, 60),
  );

  // ── GraphQL-over-SSE ──────────────────────────────────────────────────────
  console.log('\nGraphQL-over-SSE (distinct connections mode)');

  const stream = await fetch(`${http}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query: 'subscription { countdown(from: 2) }' }),
  });
  check(
    stream.headers.get('content-type') === 'text/event-stream',
    'the stream is accepted as text/event-stream',
    String(stream.headers.get('content-type')),
  );
  const body = await new Response(stream.body).text();
  const events = [...body.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  check(
    JSON.stringify(events) === '["next","next","next","complete"]',
    'events arrive as next … next … complete',
    JSON.stringify(events),
  );
  check(
    body.endsWith('event: complete\ndata: \n\n'),
    'the complete frame carries the empty data: field native EventSource needs',
  );

  const invalid = await fetch(`${http}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'subscription { nosuchfield }' }),
  });
  const invalidBody = await new Response(invalid.body).text();
  check(
    invalid.status === 200 && invalidBody.includes('Cannot query field'),
    'a validation error rides the stream rather than failing the connection',
    `status ${invalid.status}`,
  );

  // ── HTTP transport ────────────────────────────────────────────────────────
  console.log('\nHTTP transport');

  const batch = await (await fetch(http, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { query: '{ hello }' },
      { query: '{ book(id: "2") { title } }' },
      { query: '{ nope }' },
    ]),
  })).json();
  check(
    Array.isArray(batch) && batch.length === 3 && batch[0].data?.hello === 'world' &&
      batch[2].errors?.length > 0,
    'a batch answers one array, each element carrying its own result or errors',
    JSON.stringify(batch).slice(0, 100),
  );

  const refused = await fetch(http, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' },
    body: JSON.stringify({ query: 'subscription { countdown(from: 1) }' }),
  });
  const refusedBody = await refused.json();
  check(
    refused.status === 400 &&
      refusedBody.errors?.[0]?.extensions?.code === 'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP',
    'the HTTP endpoint still refuses a subscription',
    `status ${refused.status}`,
  );

  const graphiql = await fetch(http, { headers: { accept: 'text/html' } });
  check(
    (await graphiql.text()).includes('GraphiQL'),
    'GraphiQL is served for a browser request',
  );
} finally {
  await app.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  Deno.exit(1);
}
