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
    const fields: Record<string, { name: string; resolve?: unknown }> = {};
    for (const type of types) {
      fields[type] = { name: type };
    }

    return {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({
          hello: { name: 'hello', type: { name: 'String' }, args: [] },
          world: { name: 'world', type: { name: 'String' }, args: [] },
        }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (types.includes(name)) {
          return {
            name,
            getFields: () => ({
              hello: { name: 'hello', type: { name: 'String' }, args: [] },
            }),
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
