/**
 * Tests for graphql-handler.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createGraphqlHandler } from '../../src/http/graphql-handler.ts';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';

describe('createGraphqlHandler', () => {
  const createFakeRuntime = (): GraphqlRuntime =>
    ({
      parse: (_src: string) => ({ kind: 'Document', definitions: [] }),
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
      getOperationAST: () => null,
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
});
