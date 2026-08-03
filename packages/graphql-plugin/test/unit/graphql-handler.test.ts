/**
 * Tests for graphql-handler.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createGraphqlHandler } from '../../src/http/graphql-handler.ts';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type { HandlerResult, IRequestContext, IResponse } from '@hono-enterprise/common';

describe('createGraphqlHandler', () => {
  /**
   * Parse a GraphQL query string and return a document with the correct operation type.
   * This is needed for the B6 operation-kind check in graphql-service.ts.
   */
  const parseQuery = (
    src: string,
  ): { kind: 'Document'; definitions: Array<{ kind: string; operation: string }> } => {
    const trimmed = src.trim().toLowerCase();
    let operation = 'query';
    if (trimmed.startsWith('mutation') || trimmed.startsWith('mutation ')) {
      operation = 'mutation';
    } else if (trimmed.startsWith('subscription') || trimmed.startsWith('subscription ')) {
      operation = 'subscription';
    }
    return { kind: 'Document', definitions: [{ kind: 'OperationDefinition', operation }] };
  };

  /**
   * Return an AST node with the correct operation type based on the document.
   * This is needed for the B6 operation-kind check in graphql-service.ts.
   */
  const getOperationAst = (
    document: { kind: 'Document'; definitions: Array<{ kind: string; operation: string }> },
    _operationName?: string,
  ): { kind: string; operation: 'query' | 'mutation' | 'subscription' } | null => {
    if (document.definitions.length === 0) {
      return null;
    }
    const def = document.definitions[0];
    if (
      def.operation === 'mutation' || def.operation === 'subscription' || def.operation === 'query'
    ) {
      return {
        kind: 'OperationDefinition',
        operation: def.operation as 'query' | 'mutation' | 'subscription',
      };
    }
    return null;
  };

  const createFakeRuntime = (): GraphqlRuntime =>
    ({
      parse: parseQuery,
      validate: () => [],
      execute: () => Promise.resolve({ data: { hello: 'world' } }),
      subscribe: () => Promise.resolve({ data: {} }),
      buildSchema: (_src: string) => ({
        getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
        getMutationType: () => null,
        getSubscriptionType: () => null,
        getType: (name: string) => ({ name }),
        getPossibleTypes: () => [],
        getDirectives: () => [],
        getDirective: () => null,
        toAST: () => ({}),
      }),
      validateSchema: () => [],
      getOperationAST: getOperationAst,
      GraphQLError: class extends Error {
        override name = 'GraphQLError';
        toJSON() {
          return { message: this.message };
        }
      },
      NoSchemaIntrospectionCustomRule: {},
      specifiedRules: [],
    }) as GraphqlRuntime;

  const createFakeSchema = (): GraphqlSchemaLike =>
    ({
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ hello: { name: 'hello', type: { name: 'String' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => ({ name }),
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    }) as GraphqlSchemaLike;

  function createMockResponse(): { mock: IResponse; captureStatus: () => number } {
    let capturedStatus = 0;
    const mock = {
      status: (code: number) => {
        capturedStatus = code;
        return mock;
      },
      header: (_name: string, _value: string) => mock,
      send: (_body?: Uint8Array): HandlerResult => ({ __handlerResult: true }),
      json: () => mock,
      text: () => mock,
      redirect: () => mock,
      appendHeader: () => mock,
      stream: () => mock,
      snapshot: () => mock,
    } as unknown as IResponse;
    return { mock, captureStatus: () => capturedStatus };
  }

  it('returns post and get handlers', () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { post, get } = createGraphqlHandler(service, '/graphql', { graphiql: true });

    expect(typeof post).toBe('function');
    expect(typeof get).toBe('function');
  });

  it('handles POST with valid JSON body', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.resolve({ query: '{ hello }' }),
        headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    const result = await post(mockCtx);
    expect(result).toBeDefined();
  });

  it('returns 415 for POST with wrong content-type', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.resolve({ query: '{ hello }' }),
        headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await post(mockCtx);
    expect(captureStatus()).toBe(415);
  });

  it('returns 400 for POST with invalid JSON', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.reject(new Error('Invalid JSON')),
        headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await post(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('handles GET with valid query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query=%7Bhello%7D',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: '{ hello }' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(200);
  });

  it('returns 400 for GET without query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: false });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('serves GraphiQL when enabled and no query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql',
        path: '/graphql',
        headers: new Map([['accept', 'text/html']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(200);
  });

  it('returns 405 for GET with mutation query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query=mutation',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: 'mutation { doSomething }' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(405);
  });

  it('returns 400 for GET with subscription query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query=subscription',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: 'subscription { onSomething }' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('logs errors when logger is provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const logEntries: string[] = [];
    const logger = {
      info: (msg: string) => logEntries.push(`INFO: ${msg}`),
      error: (msg: string) => logEntries.push(`ERROR: ${msg}`),
    };

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true, logger });
    const { mock } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.reject(new Error('Parse error')),
        headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await post(mockCtx);
    expect(logEntries.some((e) => e.includes('ERROR'))).toBe(true);
  });

  it('logs parse error in POST when logger is provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const logEntries: string[] = [];
    const logger = {
      info: (msg: string) => logEntries.push(`INFO: ${msg}`),
      error: (msg: string) => logEntries.push(`ERROR: ${msg}`),
    };

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true, logger });
    const { mock } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.resolve({}), // Empty body causes parse error
        headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await post(mockCtx);
    expect(logEntries.some((e) => e.includes('ERROR'))).toBe(true);
  });

  it('handles parse error in GET request', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query=invalid',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: 'invalid query syntax' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    // Parse errors under json media type should yield 200 (watershed)
    expect(captureStatus()).toBe(200);
  });

  it('GET+json validation error returns 200 (watershed)', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    // Override validate to return errors
    (runtime as unknown as GraphqlRuntime).validate = () => [
      new runtime.GraphQLError('Unknown field'),
    ];

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query={unknownField}',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: '{ unknownField }' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    // Validation errors under json media type should yield 200 (watershed)
    expect(captureStatus()).toBe(200);
  });

  it('returns 400 for GET with graphiql disabled and no query', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: false });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql',
        path: '/graphql',
        headers: new Map([['accept', 'text/html']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('handles POST with parse error from parsePostBody', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { post } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'POST',
        url: 'http://test.com/graphql',
        path: '/graphql',
        json: () => Promise.resolve({}), // Empty body will cause parse error
        headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await post(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('handles GET with variables parameter', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query={hello}&variables={"name":"test"}',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {
        query: '{hello}',
        variables: '{"name":"test"}',
      },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    // Should complete successfully with 200
    expect(captureStatus()).toBe(200);
  });

  it('handles GET with parse error from query param', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: false });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql?query=%7Bhello%7D',
        path: '/graphql',
        headers: new Map() as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: { query: '{ hello', variables: 'invalid json' },
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(400);
  });

  it('returns 400 for GET when graphiql enabled but accept is not text/html', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const service = new GraphqlService(runtime, schema, {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const { get } = createGraphqlHandler(service, '/graphql', { graphiql: true });
    const { mock, captureStatus } = createMockResponse();

    const mockCtx = {
      request: {
        method: 'GET',
        url: 'http://test.com/graphql',
        path: '/graphql',
        headers: new Map([['accept', 'application/json']]) as unknown as Headers,
      } as unknown as Request,
      response: mock,
      query: {},
      params: {},
      get: () => undefined,
    } as unknown as IRequestContext;

    await get(mockCtx);
    expect(captureStatus()).toBe(400);
  });
});
