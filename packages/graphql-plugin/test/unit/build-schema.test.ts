/**
 * Tests for build-schema.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildSchema } from '../../src/schema/build-schema.ts';
import { GraphqlSchemaError } from '../../src/errors/graphql-errors.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type { GraphqlPluginOptions } from '../../src/interfaces/options.ts';

describe('build-schema', () => {
  const fakeRuntime: GraphqlRuntime = {
    parse: (_src: string) => ({ kind: 'Document', definitions: [] }),
    validate: () => [],
    execute: () => Promise.resolve({ data: {} }),
    subscribe: () => Promise.resolve({ data: {} }),
    buildSchema: (src: string) => {
      // Throw on clearly invalid SDL
      if (src === 'INVALID SDL') {
        throw new Error('Invalid SDL syntax');
      }
      return {
        getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
        getMutationType: () => null,
        getSubscriptionType: () => null,
        getType: (name: string) => ({ name: name }),
        getPossibleTypes: () => [],
        getDirectives: () => [],
        getDirective: () => null,
        toAST: () => ({}),
      };
    },
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
  };

  it('builds schema from typeDefs', () => {
    const schema = buildSchema(
      { typeDefs: 'type Query { hello: String }', resolvers: {} },
      fakeRuntime,
    );
    expect(schema).toBeDefined();
  });

  it('uses pre-built schema in code-first mode', () => {
    const customSchema = {
      getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => ({ name }),
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    };

    const schema = buildSchema({ schema: customSchema }, fakeRuntime);
    expect(schema).toBe(customSchema);
  });

  it('throws on invalid SDL', () => {
    expect(() => buildSchema({ typeDefs: 'INVALID SDL', resolvers: {} }, fakeRuntime)).toThrow(
      GraphqlSchemaError,
    );
  });

  it('throws on schema validation errors', () => {
    const runtimeWithValidation: GraphqlRuntime = {
      ...fakeRuntime,
      validateSchema: () => [{
        message: 'Schema error',
        locations: [],
        path: [],
        toJSON: () => ({ message: 'Schema error' }),
      }],
    };

    expect(() =>
      buildSchema(
        { typeDefs: 'type Query { hello: String }', resolvers: {} },
        runtimeWithValidation,
      )
    ).toThrow(GraphqlSchemaError);
  });

  it('throws when both arms are provided', () => {
    expect(() =>
      buildSchema(
        {
          typeDefs: 'type Query { hello: String }',
          resolvers: {},
          schema: {} as GraphqlSchemaLike,
        } as GraphqlPluginOptions,
        fakeRuntime,
      )
    ).toThrow();
  });
});
