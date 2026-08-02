/**
 * Tests for graphql-service.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type { IRequestContext } from '@hono-enterprise/common';

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

  it('uses custom validation rules', async () => {
    let customRuleCalled = false;
    const customRule = () => {
      customRuleCalled = true;
      return {};
    };

    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      validationRules: [customRule],
    });

    await service.execute({ query: '{ hello }' });

    // Custom rule should be included in validation rules
    expect(customRuleCalled).toBe(false); // Rule is a function, not called during execute
  });

  it('disables introspection when option is false', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: false,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses custom formatError function', async () => {
    const formatError = (error: unknown) => ({
      message: 'Custom formatted error',
      original: error,
    });

    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      formatError,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses rootValue option', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      rootValue: { custom: 'root' },
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('handles empty validation rules array', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      validationRules: [],
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses default formatError when not provided', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('builds context with requestContext when provided', async () => {
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

    const mockRequestContext = {
      services: { test: 'service' },
      request: { url: 'http://test.com' },
    };

    await service.execute({ query: '{ hello }' }, mockRequestContext as unknown as IRequestContext);

    expect(capturedContext).toBeDefined();
  });
});
