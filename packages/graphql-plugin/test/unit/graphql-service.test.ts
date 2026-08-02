/**
 * Tests for graphql-service.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';

describe('GraphqlService', () => {
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

  it('has endpoint property', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    expect(service.endpoint).toBe('/graphql');
  });

  it('reports cached document count', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    expect(service.cachedDocumentCount).toBe(0);
  });

  it('clears cache', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    (service as GraphqlService & { clearCache(): void }).clearCache();
    expect(service.cachedDocumentCount).toBe(0);
  });

  it('builds context from buildContext option', async () => {
    let capturedContext: unknown;
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      buildContext: (input) => {
        capturedContext = input;
        return { custom: 'value' };
      },
    });

    await service.execute({ query: '{ hello }' });

    expect(capturedContext).toBeDefined();
  });

  it('uses default context when buildContext is absent', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
    expect(result.result.data).toEqual({ hello: 'world' });
  });
});
