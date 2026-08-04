/**
 * Tests for transports/sse/graphql-sse-handler.ts
 *
 * Covers the full handler surface: transport-failure (buffered HTTP error)
 * branches, the GraphQL-request-error path that opens the stream and emits
 * `next` + `complete` (C4), the single/stream outcome arms, APQ resolution,
 * GET parameter parsing, and the pump (heartbeat, abort, stream error).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  GraphqlOperationContext,
  GraphqlRequestParams,
  GraphqlSubscriptionOutcome,
  IGraphqlService,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createSseHandler } from '../../src/transports/sse/graphql-sse-handler.ts';
import type { ApqResolver, ApqResolveResult } from '../../src/apq/apq-resolver.ts';

const decoder = new TextDecoder();

/** Read a captured `ReadableStream` to a string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  // Guard against a producer that never closes: stop once we have both frames.
  while (true) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 500)
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

function createMockService(
  subscribeImpl: (
    params: GraphqlRequestParams,
    ctx?: GraphqlOperationContext,
  ) => GraphqlSubscriptionOutcome,
): IGraphqlService {
  return {
    execute: () => Promise.resolve({ status: 200, result: { data: {} } }),
    subscribe: (params: GraphqlRequestParams, ctx?: GraphqlOperationContext) =>
      Promise.resolve(subscribeImpl(params, ctx)),
    get endpoint() {
      return '/graphql';
    },
    get cachedDocumentCount() {
      return 0;
    },
  };
}

function createMockResponse() {
  const captures: {
    status?: number;
    headers: Map<string, string>;
    body?: Uint8Array;
    stream?: ReadableStream<Uint8Array>;
  } = { headers: new Map() };

  const mock = {
    status: (s: number) => {
      captures.status = s;
      return mock;
    },
    header: (k: string, v: string) => {
      captures.headers.set(k, v);
      return mock;
    },
    send: (b?: Uint8Array) => {
      if (b) captures.body = b;
      return mock as unknown as IResponse;
    },
    stream: (s: ReadableStream<Uint8Array>) => {
      captures.stream = s;
      return mock as unknown as IResponse;
    },
    redirect: () => mock,
    body: () => mock,
    json: () => mock,
    html: () => mock,
    text: () => mock,
    snapshot: () => ({ streaming: false, body: null, status: captures.status ?? 200 } as const),
  } as unknown as IResponse;
  return { mock, captures };
}

interface MockRequestOpts {
  body?: unknown;
  query?: Record<string, string>;
  response?: IResponse;
  jsonThrows?: boolean;
  signal?: AbortSignal;
}

function createMockRequest(opts: MockRequestOpts = {}) {
  const q = opts.query ?? {};
  return {
    request: {
      json: opts.jsonThrows
        ? () => Promise.reject(new Error('bad json'))
        : () => Promise.resolve(opts.body),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as IRequest,
    query: q,
    response: opts.response ?? ({} as IResponse),
    services: {
      register: () => {},
      registerFactory: () => {},
      get: () => ({}) as never,
      getAll: () => [],
      has: () => false,
      unregister: () => true,
    } as unknown as IServiceRegistry,
    url: new URL('http://localhost/graphql'),
    method: 'POST',
    body: null,
    signal: opts.signal,
    user: undefined,
    tenant: undefined,
  } as unknown as IRequestContext;
}

/** Build a fake APQ resolver that returns a canned result. */
function fakeApqResolver(result: ApqResolveResult): ApqResolver {
  return {
    resolve: () => Promise.resolve(result),
  } as unknown as ApqResolver;
}

describe('createSseHandler', () => {
  it('returns post and get handlers', () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const { post, get } = createSseHandler(service, createFakeRuntime().runtime);
    expect(typeof post).toBe('function');
    expect(typeof get).toBe('function');
  });

  describe('POST', () => {
    it('transport failure: invalid JSON → 400 INVALID_JSON', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ response: mock, jsonThrows: true });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      expect(captures.status).toBe(400);
      const body = decoder.decode(captures.body!);
      expect(body).toContain('Invalid JSON body');
      expect(body).toContain('INVALID_JSON');
      expect(captures.stream).toBeUndefined();
    });

    it('transport failure: array body → 400', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: [{ query: '{ hello }' }], response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      expect(captures.status).toBe(400);
      expect(decoder.decode(captures.body!)).toContain('must be a JSON object');
    });

    it('transport failure: null body → 400', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: null, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      expect(captures.status).toBe(400);
      expect(decoder.decode(captures.body!)).toContain('must be a JSON object');
    });

    it('transport failure: query missing and no extensions → 400', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { operationName: 'X' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      expect(captures.status).toBe(400);
      expect(decoder.decode(captures.body!)).toContain('Query is required');
    });

    it('emits a GraphQL request error as next + complete inside the stream (C4)', async () => {
      const service = createMockService(() => ({
        kind: 'error',
        status: 400,
        result: { errors: [{ message: 'Validation error' }] },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: '{ error }' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      // Stream opens with 200, even though the outcome is an error.
      expect(captures.status).toBe(200);
      expect(captures.headers.get('Content-Type')).toBe('text/event-stream');
      const body = await drain(captures.stream!);
      // The `next` frame carries the error result (a `data:` line); `complete`
      // (with its mandatory empty `data:`) follows.
      expect(body).toContain('Validation error');
      expect(body).toContain('event: complete');
      expect(body).toContain('data: \n\n');
    });

    it('emits a single result as next + complete', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: { hello: 'world' } },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: '{ hello }' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      expect(captures.status).toBe(200);
      const body = await drain(captures.stream!);
      expect(body).toContain('"hello":"world"');
      expect(body).toContain('event: complete');
    });

    it('threads operationName, variables, and extensions into subscribe', async () => {
      let received: GraphqlRequestParams | undefined;
      const service = createMockService((params) => {
        received = params;
        return { kind: 'single', status: 200, result: { data: {} } };
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: {
          query: '{ hello }',
          operationName: 'Hello',
          variables: { id: '1' },
          extensions: { persistedQuery: { version: 1 } },
        },
        response: mock,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);
      await drain(captures.stream!);

      expect(received).toBeDefined();
      expect(received!.operationName).toBe('Hello');
      expect(received!.variables).toEqual({ id: '1' });
      expect(received!.extensions).toEqual({ persistedQuery: { version: 1 } });
    });

    it('rejects array variables (not threaded as variables)', async () => {
      let received: GraphqlRequestParams | undefined;
      const service = createMockService((params) => {
        received = params;
        return { kind: 'single', status: 200, result: { data: {} } };
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: { query: '{ hello }', variables: ['x'] },
        response: mock,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);
      await drain(captures.stream!);

      expect(received!.variables).toBeUndefined();
    });

    it('APQ miss is delivered IN-STREAM as next + complete, not as a 400', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const apq = fakeApqResolver({
        ok: false,
        message: 'PersistedQueryNotFound',
        code: 'PERSISTED_QUERY_NOT_FOUND',
        status: 400,
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: { extensions: { persistedQuery: { version: 1, sha256Hash: 'h' } } },
        response: mock,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime, 0, apq);
      await post(ctx);

      // A persisted-query miss is a GraphQL request error. Answering 400 makes
      // the user agent fail the connection and leaves native `EventSource`
      // with nothing readable — the same reason validation errors go in-stream.
      expect(captures.status).toBe(200);
      expect(captures.headers.get('Content-Type')).toBe('text/event-stream');
      const body = await drain(captures.stream!);
      expect(body).toContain('event: next');
      expect(body).toContain('PERSISTED_QUERY_NOT_FOUND');
      expect(body.endsWith('event: complete\ndata: \n\n')).toBe(true);
    });

    it('APQ hit injects the resolved query', async () => {
      let received: GraphqlRequestParams | undefined;
      const service = createMockService((params) => {
        received = params;
        return { kind: 'single', status: 200, result: { data: {} } };
      });
      const apq = fakeApqResolver({ ok: true, query: '{ fromApq }' });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: { extensions: { persistedQuery: { version: 1, sha256Hash: 'h' } } },
        response: mock,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime, 0, apq);
      await post(ctx);
      await drain(captures.stream!);

      expect(received!.query).toBe('{ fromApq }');
    });
  });

  describe('GET', () => {
    it('transport failure: missing query → 400', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ response: mock });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);

      expect(captures.status).toBe(400);
      expect(decoder.decode(captures.body!)).toContain('Query parameter is required');
    });

    it('streams a single result', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: { hello: 'world' } },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ query: { query: '{ hello }' }, response: mock });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);

      expect(captures.status).toBe(200);
      const body = await drain(captures.stream!);
      expect(body).toContain('"hello":"world"');
      expect(body).toContain('event: complete');
    });

    it('threads operationName and valid variables/extensions', async () => {
      let received: GraphqlRequestParams | undefined;
      const service = createMockService((params) => {
        received = params;
        return { kind: 'single', status: 200, result: { data: {} } };
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        query: {
          query: '{ hello }',
          operationName: 'Hello',
          variables: JSON.stringify({ id: '1' }),
          extensions: JSON.stringify({ persistedQuery: { version: 1 } }),
        },
        response: mock,
      });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);
      await drain(captures.stream!);

      expect(received!.operationName).toBe('Hello');
      expect(received!.variables).toEqual({ id: '1' });
      expect(received!.extensions).toEqual({ persistedQuery: { version: 1 } });
    });

    it('ignores malformed variables JSON (does not throw)', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        query: { query: '{ hello }', variables: 'not json' },
        response: mock,
      });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);

      expect(captures.status).toBe(200);
    });

    it('ignores non-object variables JSON (array)', async () => {
      let received: GraphqlRequestParams | undefined;
      const service = createMockService((params) => {
        received = params;
        return { kind: 'single', status: 200, result: { data: {} } };
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        query: { query: '{ hello }', variables: '[1,2]' },
        response: mock,
      });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);
      await drain(captures.stream!);

      expect(received!.variables).toBeUndefined();
    });

    it('ignores malformed extensions JSON', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        query: { query: '{ hello }', extensions: 'not json' },
        response: mock,
      });

      const { get } = createSseHandler(service, createFakeRuntime().runtime);
      await get(ctx);

      expect(captures.status).toBe(200);
    });

    it('APQ miss is delivered in-stream on the GET path too', async () => {
      const service = createMockService(() => ({
        kind: 'single',
        status: 200,
        result: { data: {} },
      }));
      const apq = fakeApqResolver({
        ok: false,
        message: 'PersistedQueryNotFound',
        code: 'PERSISTED_QUERY_NOT_FOUND',
        status: 400,
      });
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ query: { query: '{ hello }' }, response: mock });

      const { get } = createSseHandler(service, createFakeRuntime().runtime, 0, apq);
      await get(ctx);

      expect(captures.status).toBe(200);
      const body = await drain(captures.stream!);
      expect(body).toContain('PERSISTED_QUERY_NOT_FOUND');
      expect(body).toContain('event: complete');
    });
  });

  describe('stream pump', () => {
    it('pumps multiple next frames then complete', async () => {
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          yield { data: { tick: 0 } };
          yield { data: { tick: 1 } };
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      const body = await drain(captures.stream!);
      // Each `next` result is a `data: {…}` line; the terminator is a complete.
      expect(body.match(/data: \{/g)?.length).toBe(2);
      expect(body).toContain('"tick":0');
      expect(body).toContain('"tick":1');
      expect(body).toContain('event: complete');
    });

    it('emits keep-alive comments when heartbeatMs > 0', async () => {
      // Held open until the test releases it, so the heartbeat tick lands
      // while the stream is genuinely idle.
      const gate = Promise.withResolvers<void>();
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          await gate.promise;
          yield { data: { tick: 0 } };
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

      const { fake, runtime } = createFakeRuntime();
      const { post } = createSseHandler(service, runtime, 5);
      await post(ctx);

      // Driven rather than waited on — the handler takes its timer from
      // runtime services so this tick is deterministic.
      fake.runTimers();
      gate.resolve();

      const body = await drain(captures.stream!);
      expect(body).toContain(':keep-alive');
      // The keep-alive interval must be released when the pump finishes.
      expect(fake.activeTimerCount).toBe(0);
    });

    it('stops pumping when the request signal aborts', async () => {
      const ac = new AbortController();
      let iterated = 0;
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          yield { data: { tick: 0 } };
          iterated++;
          // Abort before the next yield is consumed.
          ac.abort();
          await new Promise((r) => setTimeout(r, 10));
          yield { data: { tick: 1 } };
          iterated++;
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: { query: 'subscription { tick }' },
        response: mock,
        signal: ac.signal,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);
      const body = await drain(captures.stream!);

      // First next is emitted; the abort breaks the pump before completing.
      expect(body).toContain('"tick":0');
      // The second value is produced by the iterable but the pump has exited.
      expect(iterated).toBeGreaterThanOrEqual(1);
    });

    // C5 regression: abort listener must call iterator.return() on idle disconnect.
    it('C5: abort while idle calls iterator.return() and stops the pump', async () => {
      const ac = new AbortController();
      let returnCalled = false;
      // Build a custom async iterable where we can observe iterator.return().
      const iter = {
        [Symbol.asyncIterator]: () => iter,
        next: () =>
          new Promise<{ done: boolean; value: unknown }>((resolve) => {
            setTimeout(() => resolve({ done: false, value: { data: { tick: 0 } } }), 50);
          }),
        return: () => {
          returnCalled = true;
          return Promise.resolve({ done: true, value: undefined });
        },
        throw: (e: unknown) => Promise.reject(e),
      };

      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: iter as never,
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({
        body: { query: 'subscription { tick }' },
        response: mock,
        signal: ac.signal,
      });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      // Start the pump, then abort after a short delay so the abort listener
      // fires while the pump is idle (waiting for the next value).
      const postPromise = post(ctx);
      await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      await postPromise;
      const body = await drain(captures.stream!);

      // The pump should have stopped and emitted complete.
      expect(body).toContain('event: complete');
      // The abort listener must have called iterator.return().
      expect(returnCalled).toBe(true);
    });

    it('maps a thrown stream into next(error) + complete', async () => {
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          yield { data: { tick: 0 } };
          throw new Error('stream blew up');
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      const body = await drain(captures.stream!);
      // The pump must NOT put a raw producer message into the stream. Masking
      // is the service's job; this last-resort frame is generic so a
      // misbehaving iterator cannot publish internals the HTTP path masks.
      expect(body).not.toContain('stream blew up');
      expect(body).toContain('Internal server error');
      expect(body).toContain('event: complete');
    });

    it('maps a non-Error stream throw into a generic message', async () => {
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          yield { data: { tick: 0 } };
          throw 'string-thrown';
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

      const { post } = createSseHandler(service, createFakeRuntime().runtime);
      await post(ctx);

      const body = await drain(captures.stream!);
      expect(body).not.toContain('string-thrown');
      expect(body).toContain('Internal server error');
      expect(body).toContain('event: complete');
    });
  });
});

describe('createSseHandler — a consumer that goes away', () => {
  it('stops the pump on cancel instead of throwing into a dead controller', async () => {
    let produced = 0;
    let released = false;
    const gate = Promise.withResolvers<void>();
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              produced++;
              if (produced > 1) await gate.promise;
              return { done: false, value: { data: { tick: produced } } };
            },
            // deno-lint-ignore require-await
            async return() {
              released = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      },
    }));
    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

    const { post } = createSseHandler(service, createFakeRuntime().runtime);
    await post(ctx);

    // Read one frame, then walk away — which is what a disconnecting client
    // does. Without the controller's `cancel` hook the pump kept enqueueing
    // into a dead controller and every call threw out of a fire-and-forget
    // promise.
    const reader = captures.stream!.getReader();
    await reader.read();
    await reader.cancel();

    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(released).toBe(true);
    // Bounded: the pump noticed the cancel rather than running forever.
    expect(produced).toBeLessThan(10);
  });
});
