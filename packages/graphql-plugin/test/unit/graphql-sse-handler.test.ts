/**
 * Tests for transports/sse/graphql-sse-handler.ts
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

const decoder = new TextDecoder();

function createMockService(
  overrideSubscribe?: (
    params: GraphqlRequestParams,
    ctx?: GraphqlOperationContext,
  ) => Promise<GraphqlSubscriptionOutcome>,
): IGraphqlService {
  const defaultSubscribe = async (
    params: GraphqlRequestParams,
  ): Promise<GraphqlSubscriptionOutcome> => {
    if (params.query.includes('error')) {
      return {
        kind: 'error',
        status: 400,
        result: { errors: [{ message: 'Validation error' }] },
      };
    }
    return {
      kind: 'single',
      status: 200,
      result: { data: { hello: 'world' } },
    };
  };
  return {
    execute: async () => ({ status: 200, result: { data: {} } }),
    subscribe: overrideSubscribe ?? defaultSubscribe,
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
    send: (_b?: Uint8Array) => {
      if (_b) captures.body = _b;
      return mock as unknown as IResponse;
    },
    stream: (s: ReadableStream<Uint8Array>) => {
      captures.stream = s;
      return mock as unknown as IResponse;
    },
    redirect: (_url?: URL) => mock,
    body: () => mock,
    json: () => mock,
    html: () => mock,
    text: () => mock,
    snapshot: () => ({ streaming: false, body: null, status: captures.status ?? 200 } as const),
  } as unknown as IResponse;
  return { mock, captures };
}

function createMockRequest(
  body?: unknown,
  query?: Record<string, string>,
  response?: IResponse,
) {
  const q = query ?? {};
  return {
    request: {
      json: async () => body,
      headers: new Headers({ 'content-type': 'application/json' }),
      query: q,
    } as unknown as IRequest,
    query: q,
    response: response ?? ({} as IResponse),
    services: {
      register: () => {},
      registerFactory: () => {},
      get: () => ({}) as never,
      getAll: () => [],
      has: () => false,
      unregister: () => true,
    } as IServiceRegistry,
    url: new URL('http://localhost/graphql'),
    method: 'POST',
    body: null,
    signal: undefined,
    user: undefined,
    tenant: undefined,
  } as unknown as IRequestContext;
}

describe('createSseHandler', () => {
  it('returns post and get handlers', () => {
    const service = createMockService();
    const { post, get } = createSseHandler(service);
    expect(typeof post).toBe('function');
    expect(typeof get).toBe('function');
  });

  it('POST: transport failure for invalid JSON', async () => {
    const service = createMockService();
    const { mock, captures } = createMockResponse();
    const ctx: IRequestContext = {
      request: {
        json: async () => {
          throw new Error('bad json');
        },
        headers: new Headers({ 'content-type': 'application/json' }),
      } as unknown as IRequest,
      response: mock,
      services: {} as IServiceRegistry,
      url: new URL('http://localhost/graphql'),
      method: 'POST',
      body: null,
      signal: undefined,
      user: undefined,
      tenant: undefined,
      query: {},
    } as unknown as IRequestContext;

    const { post } = createSseHandler(service);
    await post(ctx);

    expect(captures.status).toBe(400);
    const body = decoder.decode(captures.body!);
    expect(body).toContain('Invalid JSON body');
  });

  it('POST: GraphQL error emitted inside stream (C4)', async () => {
    const service = createMockService();
    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest({ query: '{ error }' }, {}, mock);

    const { post } = createSseHandler(service);
    await post(ctx);

    expect(captures.status).toBe(200);
    expect(captures.headers.get('Content-Type')).toBe('text/event-stream');
    expect(captures.stream).toBeDefined();
  });

  it('POST: single result emits next then complete', async () => {
    const service = createMockService();
    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest({ query: '{ hello }' }, {}, mock);

    const { post } = createSseHandler(service);
    await post(ctx);

    expect(captures.status).toBe(200);
    expect(captures.stream).toBeDefined();
  });

  it('GET: transport failure when query missing', async () => {
    const service = createMockService();
    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest(undefined, {}, mock);

    const { get } = createSseHandler(service);
    await get(ctx);

    expect(captures.status).toBe(400);
    const body = decoder.decode(captures.body!);
    expect(body).toContain('Query parameter is required');
  });

  it('GET: streams result when query present', async () => {
    const service = createMockService();
    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest(undefined, { query: '{ hello }' }, mock);

    const { get } = createSseHandler(service);
    await get(ctx);

    expect(captures.status).toBe(200);
    expect(captures.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('POST: streaming subscription pumps results', async () => {
    let index = 0;
    const service = createMockService(async () => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        while (index < 2) {
          yield { data: { tick: index } };
          index++;
        }
      })(),
    }));

    const { mock, captures } = createMockResponse();
    const ctx = createMockRequest({ query: 'subscription { tick }' }, {}, mock);

    const { post } = createSseHandler(service);
    await post(ctx);

    expect(captures.status).toBe(200);
    expect(captures.stream).toBeDefined();
  });
});
