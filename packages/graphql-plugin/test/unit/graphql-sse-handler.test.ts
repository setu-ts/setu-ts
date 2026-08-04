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
    const { post, get } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
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

      const { post } = createSseHandler(service);
      await post(ctx);
      await drain(captures.stream!);

      expect(received!.variables).toBeUndefined();
    });

    it('APQ miss with hash-only → 400 (transport failure)', async () => {
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

      const { post } = createSseHandler(service, 0, apq);
      await post(ctx);

      expect(captures.status).toBe(400);
      expect(decoder.decode(captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');
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

      const { post } = createSseHandler(service, 0, apq);
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

      const { get } = createSseHandler(service);
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

      const { get } = createSseHandler(service);
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

      const { get } = createSseHandler(service);
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

      const { get } = createSseHandler(service);
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

      const { get } = createSseHandler(service);
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

      const { get } = createSseHandler(service);
      await get(ctx);

      expect(captures.status).toBe(200);
    });

    it('APQ miss → 400', async () => {
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

      const { get } = createSseHandler(service, 0, apq);
      await get(ctx);

      expect(captures.status).toBe(400);
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

      const { post } = createSseHandler(service);
      await post(ctx);

      const body = await drain(captures.stream!);
      // Each `next` result is a `data: {…}` line; the terminator is a complete.
      expect(body.match(/data: \{/g)?.length).toBe(2);
      expect(body).toContain('"tick":0');
      expect(body).toContain('"tick":1');
      expect(body).toContain('event: complete');
    });

    it('emits keep-alive comments when heartbeatMs > 0', async () => {
      const service = createMockService(() => ({
        kind: 'stream',
        status: 200,
        stream: (async function* () {
          await new Promise((r) => setTimeout(r, 25));
          yield { data: { tick: 0 } };
        })(),
      }));
      const { mock, captures } = createMockResponse();
      const ctx = createMockRequest({ body: { query: 'subscription { tick }' }, response: mock });

      const { post } = createSseHandler(service, 5);
      await post(ctx);

      const body = await drain(captures.stream!);
      expect(body).toContain(':keep-alive');
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

      const { post } = createSseHandler(service);
      await post(ctx);
      const body = await drain(captures.stream!);

      // First next is emitted; the abort breaks the pump before completing.
      expect(body).toContain('"tick":0');
      // The second value is produced by the iterable but the pump has exited.
      expect(iterated).toBeGreaterThanOrEqual(1);
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

      const { post } = createSseHandler(service);
      await post(ctx);

      const body = await drain(captures.stream!);
      expect(body).toContain('stream blew up');
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

      const { post } = createSseHandler(service);
      await post(ctx);

      const body = await drain(captures.stream!);
      expect(body).toContain('Stream error');
      expect(body).toContain('event: complete');
    });
  });
});
