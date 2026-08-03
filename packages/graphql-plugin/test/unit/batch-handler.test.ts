/**
 * Tests for http/graphql-handler.ts batch branch
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createGraphqlHandler } from '../../src/http/graphql-handler.ts';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type { IRequest, IRequestContext, IResponse } from '@hono-enterprise/common';

const createFakeRuntime = (): GraphqlRuntime =>
  ({
    parse: (_src: string) => ({
      kind: 'Document',
      definitions: [{
        kind: 'OperationDefinition',
        operation: 'query',
        selectionSet: { kind: 'SelectionSet', selections: [] },
      }],
    }),
    validate: () => [],
    execute: () => Promise.resolve({ data: { hello: 'world' } }),
    subscribe: () => Promise.resolve({ data: {} }),
    buildSchema: () => ({}),
    validateSchema: () => [],
    getOperationAST: (document: { definitions: unknown[] }) => document.definitions[0] ?? null,
    GraphQLError: class extends Error {
      override name = 'GraphQLError';
      toJSON() {
        return { message: this.message };
      }
    },
    NoSchemaIntrospectionCustomRule: {},
    specifiedRules: [],
  }) as unknown as GraphqlRuntime;

const createFakeSchema = (): GraphqlSchemaLike =>
  ({
    getQueryType: () => ({
      name: 'Query',
      getFields: () => ({ hello: { name: 'hello' } }),
      getInterfaces: () => [],
    }),
    getMutationType: () => null,
    getSubscriptionType: () => null,
    getType: () => null,
    getPossibleTypes: () => [],
    getDirectives: () => [],
    getDirective: () => null,
    toAST: () => ({}),
  }) as unknown as GraphqlSchemaLike;

function createMockResponse() {
  const captures: {
    status?: number;
    headers: Map<string, string>;
    body?: Uint8Array;
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
    send: (b: Uint8Array) => {
      captures.body = b;
      return mock;
    },
    stream: (_s: ReadableStream<Uint8Array>) => mock,
    redirect: () => mock,
    body: () => mock,
    json: () => mock,
    html: () => mock,
    text: () => mock,
    snapshot: () => ({ streaming: false, body: null }),
  } as unknown as IResponse;
  return { mock, captures };
}

const createMockContext = (body: unknown, accept = 'application/json') => {
  return {
    request: {
      json: async () => body,
      headers: new Headers({
        'content-type': 'application/json',
        'accept': accept,
      }),
    } as unknown as IRequest,
    response: {} as IResponse,
    services: {
      register: () => {},
      registerFactory: () => {},
      get: () => ({}) as never,
      getAll: () => [],
      has: () => false,
      unregister: () => true,
    },
  } as unknown as IRequestContext;
};

describe('batch handler', () => {
  it('array body returns array of results when maxBatchSize > 0', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 10,
      apqResolver: null,
    });

    const body = [
      { query: '{ hello }' },
      { query: '{ hello }' },
    ];
    const ctx = createMockContext(body);
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(200);
    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  it('order preserved in batch results', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 10,
      apqResolver: null,
    });

    const body = [
      { query: '{ hello }' },
      { query: '{ hello }' },
    ];
    const ctx = createMockContext(body);
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    expect(result[0].data).toEqual({ hello: 'world' });
    expect(result[1].data).toEqual({ hello: 'world' });
  });

  it('empty array returns 400', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 10,
      apqResolver: null,
    });

    const ctx = createMockContext([]);
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(400);
    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    expect(result.errors[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('over-limit batch returns BATCH_TOO_LARGE', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 2,
      apqResolver: null,
    });

    const ctx = createMockContext([
      { query: '{ a }' },
      { query: '{ b }' },
      { query: '{ c }' },
    ]);
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(400);
    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    expect(result.errors[0].extensions.code).toBe('BATCH_TOO_LARGE');
  });

  it('maxBatchSize: 0 still refuses array', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 0,
      apqResolver: null,
    });

    const ctx = createMockContext([{ query: '{ hello }' }]);
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(400);
  });

  it('strict media type refuses batch with BATCHING_NOT_SUPPORTED', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 10,
      apqResolver: null,
    });

    const ctx = createMockContext([{ query: '{ hello }' }], 'application/graphql-response+json');
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(400);
    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    expect(result.errors[0].extensions.code).toBe('BATCHING_NOT_SUPPORTED');
  });

  it('non-array body takes single path', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      serviceRegistry: {} as never,
    });

    const { mock, captures } = createMockResponse();
    const { post } = createGraphqlHandler(service, '/graphql', {
      graphiql: true,
      maxBatchSize: 10,
      apqResolver: null,
    });

    const ctx = createMockContext({ query: '{ hello }' });
    // @ts-ignore: readonly property for test mock
    (ctx as { response?: IResponse }).response = mock;

    await post(ctx);

    expect(captures.status).toBe(200);
    const result = JSON.parse(new TextDecoder().decode(captures.body!));
    // Single result, not an array
    expect(Array.isArray(result)).toBe(false);
    expect(result.data).toEqual({ hello: 'world' });
  });
});
