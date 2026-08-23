/**
 * Tests for http/graphql-handler.ts — APQ integration, batch edge cases,
 * variable handling, and the GET path (GraphiQL / query execution).
 *
 * Extends the coverage of graphql-handler.ts beyond the batch-array cases in
 * batch-handler.test.ts.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createGraphqlHandler } from '../../src/http/graphql-handler.ts';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import { ApqResolver } from '../../src/apq/apq-resolver.ts';
import { persistedQueryHash } from '../../src/apq/persisted-query.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type {
  ApqResolver as ApqResolverType,
  ApqResolveResult,
} from '../../src/apq/apq-resolver.ts';
import type { IRequest, IRequestContext, IResponse } from '@setu-ts/common';

const subtle = globalThis.crypto.subtle;

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
    stream: () => mock,
    redirect: () => mock,
    body: () => mock,
    json: () => mock,
    html: () => mock,
    text: () => mock,
    snapshot: () => ({ streaming: false, body: null }),
  } as unknown as IResponse;
  return { mock, captures };
}

interface CtxOpts {
  body?: unknown;
  query?: Record<string, string>;
  accept?: string;
  contentType?: string;
  method?: string;
  jsonThrows?: boolean;
}

function createMockContext(opts: CtxOpts = {}) {
  const q = opts.query ?? {};
  return {
    request: {
      json: opts.jsonThrows
        ? () => Promise.reject(new Error('bad json'))
        : () => Promise.resolve(opts.body),
      headers: new Headers({
        'content-type': opts.contentType ?? 'application/json',
        accept: opts.accept ?? 'application/json',
      }),
    } as unknown as IRequest,
    query: q,
    response: {} as IResponse,
    services: {
      register: () => {},
      registerFactory: () => {},
      get: () => ({}) as never,
      getAll: () => [],
      has: () => false,
      unregister: () => true,
    },
    url: new URL('http://localhost/graphql'),
    method: opts.method ?? 'POST',
    body: null,
    signal: undefined,
    user: undefined,
    tenant: undefined,
  } as unknown as IRequestContext;
}

function makeService() {
  return new GraphqlService(createFakeRuntime(), createFakeSchema(), {
    endpoint: '/graphql',
    documentCacheSize: 100,
    maxDepth: 10,
    introspection: true,
    maskInternalErrors: true,
    serviceRegistry: {} as never,
  });
}

function fakeApq(result: ApqResolveResult): ApqResolverType {
  return { resolve: () => Promise.resolve(result) } as unknown as ApqResolverType;
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('graphql-handler — APQ, batch edges, variables, GET', () => {
  describe('POST single with APQ', () => {
    it('resolves the query via APQ hit and executes', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: fakeApq({ ok: true, query: '{ hello }' }),
      });
      const ctx = createMockContext({ body: {} });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
      expect(dec(captures.body!)).toContain('"hello":"world"');
    });

    it('returns the APQ miss with its code (200 under application/json, M70i X6-7)', async () => {
      // The documented watershed keeps exactly three statuses under
      // application/json; an APQ miss is a GraphQL result the client MUST read
      // and retry, so it answers 200 with the error in the body.
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: fakeApq({
          ok: false,
          message: 'PersistedQueryNotFound',
          code: 'PERSISTED_QUERY_NOT_FOUND',
          status: 400,
        }),
      });
      const ctx = createMockContext({ body: {} });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
      expect(dec(captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');
    });

    it('returns the APQ hash mismatch with its code (200 under application/json)', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: fakeApq({
          ok: false,
          message: 'Persisted query hash mismatch',
          code: 'PERSISTED_QUERY_HASH_MISMATCH',
          status: 400,
        }),
      });
      const ctx = createMockContext({ body: { query: '{ hello }' } });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
      expect(dec(captures.body!)).toContain('PERSISTED_QUERY_HASH_MISMATCH');
    });

    it('full APQ retry handshake against a real resolver (persist → miss → hit)', async () => {
      const resolver = new ApqResolver(null, subtle, { maxEntries: 5 });
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: resolver,
      });

      const query = '{ hello }';
      const hash = await persistedQueryHash(query, subtle);

      // 1. Hash-only miss → 200 with PERSISTED_QUERY_NOT_FOUND in the body
      //    (application/json watershed; the client reads the error and retries).
      const miss = createMockContext({
        body: { extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
      });
      const missResp = createMockResponse();
      (miss as { response?: IResponse }).response = missResp.mock;
      await post(miss);
      expect(missResp.captures.status).toBe(200);
      expect(dec(missResp.captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');

      // 2. Retry with query + hash → persists, executes 200.
      const retry = createMockContext({
        body: {
          query,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        },
      });
      const retryResp = createMockResponse();
      (retry as { response?: IResponse }).response = retryResp.mock;
      await post(retry);
      expect(retryResp.captures.status).toBe(200);

      // 3. Hash-only now hits → executes 200.
      const hit = createMockContext({
        body: { extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
      });
      const hitResp = createMockResponse();
      (hit as { response?: IResponse }).response = hitResp.mock;
      await post(hit);
      expect(hitResp.captures.status).toBe(200);
    });
  });

  describe('POST variables / body edges', () => {
    it('accepts null variables', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ body: { query: '{ hello }', variables: null } });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
    });

    it('rejects array variables with INVALID_VARIABLES', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ body: { query: '{ hello }', variables: [1, 2] } });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(400);
      expect(dec(captures.body!)).toContain('INVALID_VARIABLES');
    });

    it('rejects a non-object, non-array body with BAD_REQUEST', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ body: 'a bare string' });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(400);
      expect(dec(captures.body!)).toContain('must be a JSON object');
    });

    it('rejects unsupported content type with 415', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ body: { query: '{ hello }' }, contentType: 'text/plain' });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(415);
    });

    it('rejects invalid JSON with INVALID_JSON', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ jsonThrows: true });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(400);
      expect(dec(captures.body!)).toContain('INVALID_JSON');
    });
  });

  describe('POST batch edges', () => {
    it('refuses a batch under strict media type with BATCHING_NOT_SUPPORTED', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 10,
        apqResolver: null,
      });
      const ctx = createMockContext({
        body: [{ query: '{ hello }' }],
        accept: 'application/graphql-response+json',
      });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(400);
      expect(dec(captures.body!)).toContain('BATCHING_NOT_SUPPORTED');
    });

    it('includes a per-item error for a non-object batch element', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 10,
        apqResolver: null,
      });
      const ctx = createMockContext({ body: [{ query: '{ hello }' }, 'not-an-object'] });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
      const results = JSON.parse(dec(captures.body!)) as Array<
        { errors?: unknown[]; data?: unknown }
      >;
      expect(results.length).toBe(2);
      expect(results[1]!.errors).toBeDefined();
      expect(results[1]!.data).toBeUndefined();
    });

    it('resolves APQ per batch element', async () => {
      const { mock, captures } = createMockResponse();
      const { post } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 10,
        apqResolver: fakeApq({ ok: true, query: '{ hello }' }),
      });
      const ctx = createMockContext({
        body: [
          { extensions: { persistedQuery: { version: 1, sha256Hash: 'h' } } },
          { query: '{ hello }' },
        ],
      });
      (ctx as { response?: IResponse }).response = mock;

      await post(ctx);

      expect(captures.status).toBe(200);
      const results = JSON.parse(dec(captures.body!)) as Array<{ data?: unknown }>;
      expect(results.length).toBe(2);
    });
  });

  describe('GET', () => {
    it('serves the GraphiQL page for an HTML accept with no query', async () => {
      const { mock, captures } = createMockResponse();
      const { get } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ query: {}, accept: 'text/html', method: 'GET' });
      (ctx as { response?: IResponse }).response = mock;

      await get(ctx);

      expect(captures.status).toBe(200);
      expect(captures.headers.get('Content-Type')).toContain('text/html');
    });

    it('returns 400 for no query and no HTML accept', async () => {
      const { mock, captures } = createMockResponse();
      const { get } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ query: {}, accept: 'application/json', method: 'GET' });
      (ctx as { response?: IResponse }).response = mock;

      await get(ctx);

      expect(captures.status).toBe(400);
    });

    it('executes a query from the query parameter', async () => {
      const { mock, captures } = createMockResponse();
      const { get } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({ query: { query: '{ hello }' }, method: 'GET' });
      (ctx as { response?: IResponse }).response = mock;

      await get(ctx);

      expect(captures.status).toBe(200);
      expect(dec(captures.body!)).toContain('"hello":"world"');
    });

    it('returns 400 for invalid variables JSON in the query parameter', async () => {
      const { mock, captures } = createMockResponse();
      const { get } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: null,
      });
      const ctx = createMockContext({
        query: { query: '{ hello }', variables: 'not json' },
        method: 'GET',
      });
      (ctx as { response?: IResponse }).response = mock;

      await get(ctx);

      expect(captures.status).toBe(400);
      expect(dec(captures.body!)).toContain('INVALID_VARIABLES');
    });

    // C6 regression: GET must parse extensions and resolve APQ.
    it('C6: GET resolves APQ query+hash verify path', async () => {
      const resolver = new ApqResolver(null, subtle, { maxEntries: 5 });
      const query = '{ hello }';
      const hash = await persistedQueryHash(query, subtle);

      const { mock, captures } = createMockResponse();
      const { get } = createGraphqlHandler(makeService(), '/graphql', {
        graphiql: true,
        maxBatchSize: 0,
        apqResolver: resolver,
      });
      // Query + matching hash: the resolver verifies and persists.
      const ctx = createMockContext({
        query: {
          query,
          extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
        },
        method: 'GET',
      });
      (ctx as { response?: IResponse }).response = mock;

      await get(ctx);

      expect(captures.status).toBe(200);
      expect(dec(captures.body!)).toContain('"hello":"world"');
    });
  });

  /**
   * The X6-7 APQ refusal matrix: every refusal site × every negotiated media
   * type. `application/json` → 200 (the documented "exactly three" watershed);
   * `application/graphql-response+json` → the APQ result's own status. The body
   * carries `PersistedQueryNotFound` in every cell.
   */
  describe('graphql-handler — APQ refusal matrix (M70i X6-7)', () => {
    const APQ_MISS = {
      ok: false,
      message: 'PersistedQueryNotFound',
      code: 'PERSISTED_QUERY_NOT_FOUND',
      status: 400,
    } as const;

    const STRICT_ACCEPT = 'application/graphql-response+json';

    it('single POST: 200 under application/json, 400 under graphql-response', async () => {
      for (
        const [accept, expected] of [
          ['application/json', 200],
          [STRICT_ACCEPT, 400],
        ] as const
      ) {
        const { mock, captures } = createMockResponse();
        const { post } = createGraphqlHandler(makeService(), '/graphql', {
          graphiql: true,
          maxBatchSize: 0,
          apqResolver: fakeApq(APQ_MISS),
        });
        const ctx = createMockContext({ body: {}, accept });
        (ctx as { response?: IResponse }).response = mock;

        await post(ctx);

        expect(captures.status).toBe(expected);
        expect(dec(captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');
      }
    });

    it('batch POST: 200 under application/json (plan-measured deviation for strict)', async () => {
      // application/json: the per-element APQ miss answers 200 with the error.
      {
        const { mock, captures } = createMockResponse();
        const { post } = createGraphqlHandler(makeService(), '/graphql', {
          graphiql: true,
          maxBatchSize: 10,
          apqResolver: fakeApq(APQ_MISS),
        });
        const ctx = createMockContext({
          body: [{ extensions: { persistedQuery: { version: 1, sha256Hash: 'h' } } }],
          accept: 'application/json',
        });
        (ctx as { response?: IResponse }).response = mock;

        await post(ctx);

        expect(captures.status).toBe(200);
        expect(dec(captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');
      }
      // Plan-measured deviation: under graphql-response the batch is refused
      // BATCHING_NOT_SUPPORTED (400) BEFORE per-element APQ resolution, so an
      // APQ miss is unreachable in this cell. The 400 is the documented
      // transport-failure status, not the APQ watershed.
      {
        const { mock, captures } = createMockResponse();
        const { post } = createGraphqlHandler(makeService(), '/graphql', {
          graphiql: true,
          maxBatchSize: 10,
          apqResolver: fakeApq(APQ_MISS),
        });
        const ctx = createMockContext({
          body: [{ extensions: { persistedQuery: { version: 1, sha256Hash: 'h' } } }],
          accept: STRICT_ACCEPT,
        });
        (ctx as { response?: IResponse }).response = mock;

        await post(ctx);

        expect(captures.status).toBe(400);
        expect(dec(captures.body!)).toContain('BATCHING_NOT_SUPPORTED');
      }
    });

    it('GET: 200 under application/json, 400 under graphql-response', async () => {
      // GET requires a `query` param before APQ resolution (C6 verify path), so
      // the miss is a query+hash pair the resolver rejects.
      for (
        const [accept, expected] of [
          ['application/json', 200],
          [STRICT_ACCEPT, 400],
        ] as const
      ) {
        const { mock, captures } = createMockResponse();
        const { get } = createGraphqlHandler(makeService(), '/graphql', {
          graphiql: true,
          maxBatchSize: 0,
          apqResolver: fakeApq(APQ_MISS),
        });
        const ctx = createMockContext({
          query: {
            query: '{ hello }',
            extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'h' } }),
          },
          accept,
          method: 'GET',
        });
        (ctx as { response?: IResponse }).response = mock;

        await get(ctx);

        expect(captures.status).toBe(expected);
        expect(dec(captures.body!)).toContain('PERSISTED_QUERY_NOT_FOUND');
      }
    });
  });
});
