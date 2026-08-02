/**
 * Tests for attach-resolvers.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { attachResolvers } from '../../src/schema/attach-resolvers.ts';
import { GraphqlSchemaError } from '../../src/errors/graphql-errors.ts';
import type { GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';

describe('attach-resolvers', () => {
  const createSchema = (types: string[] = ['Query']): GraphqlSchemaLike => {
    // Create shared field objects so mutations persist
    const helloField = { name: 'hello', type: { name: 'String' }, args: [] };
    const worldField = { name: 'world', type: { name: 'String' }, args: [] };
    const queryFields = { hello: helloField, world: worldField };

    return {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => queryFields,
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (types.includes(name)) {
          return {
            name,
            getFields: () => queryFields,
          };
        }
        return null;
      },
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    };
  };

  it('attaches resolvers to fields', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      Query: {
        hello: () => 'Hello',
      },
    };

    attachResolvers(schema, resolverMap);

    const fields = schema.getQueryType()!.getFields();
    expect(fields.hello.resolve).toBeDefined();
  });

  it('throws on unknown type', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      UnknownType: {
        field: () => 'value',
      },
    };

    expect(() => attachResolvers(schema, resolverMap)).toThrow(GraphqlSchemaError);
  });

  it('throws on unknown field', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      Query: {
        unknownField: () => 'value',
      },
    };

    expect(() => attachResolvers(schema, resolverMap)).toThrow(GraphqlSchemaError);
  });

  it('throws on scalar type', () => {
    const schema = createSchema(['Query', 'String'] as unknown as string[]);
    const resolverMap = {
      String: {
        custom: () => 'value',
      },
    };

    expect(() => attachResolvers(schema, resolverMap)).toThrow(GraphqlSchemaError);
  });
});
