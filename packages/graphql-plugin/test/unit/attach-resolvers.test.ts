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

  it('throws on scalar type without getFields', () => {
    const schema = {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ hello: { name: 'hello', type: { name: 'String' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (name === 'String') {
          // Scalar type has no getFields
          return {
            name: 'String',
          };
        }
        if (name === 'Query') {
          return {
            name: 'Query',
            getFields: () => ({ hello: { name: 'hello', type: { name: 'String' }, args: [] } }),
            getInterfaces: () => [],
          };
        }
        return null;
      },
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    } as GraphqlSchemaLike;

    const resolverMap = {
      String: {
        custom: () => 'value',
      },
    };

    expect(() => attachResolvers(schema, resolverMap)).toThrow(GraphqlSchemaError);
  });

  it('skips __resolveType for field resolver', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      Query: {
        hello: () => 'Hello',
        __resolveType: () => 'String',
      },
    };

    // Should not throw - __resolveType is skipped for field resolver
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
  });

  it('handles multiple fields', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      Query: {
        hello: () => 'Hello',
        world: () => 'World',
      },
    };

    attachResolvers(schema, resolverMap);

    const fields = schema.getQueryType()!.getFields();
    expect(fields.hello.resolve).toBeDefined();
    expect(fields.world.resolve).toBeDefined();
  });

  it('attaches resolver that receives args', () => {
    const schema = createSchema(['Query']);
    let receivedArgs: unknown = null;

    const resolverMap = {
      Query: {
        hello: (_src: unknown, args: Record<string, unknown>) => {
          receivedArgs = args;
          return 'Hello';
        },
      },
    };

    attachResolvers(schema, resolverMap);

    const fields = schema.getQueryType()!.getFields();
    const result = fields.hello.resolve!({}, { name: 'World' }, {}, {});

    expect(result).toBe('Hello');
    expect(receivedArgs).toEqual({ name: 'World' });
  });

  it('handles empty resolver map', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {};

    attachResolvers(schema, resolverMap);

    // Should complete without errors
    expect(true).toBe(true);
  });

  it('handles __resolveType for interface types', () => {
    const schema = createSchema(['Query', 'Node']);
    const resolverMap = {
      Node: {
        __resolveType: () => 'User',
      },
    };

    // Should not throw - __resolveType handling is a no-op in current implementation
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
  });

  it('throws on unknown type for __resolveType', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      UnknownInterface: {
        __resolveType: () => 'User',
      },
    };

    expect(() => attachResolvers(schema, resolverMap)).toThrow(GraphqlSchemaError);
  });

  it('handles resolver with both field resolvers and __resolveType', () => {
    const schema = createSchema(['Query', 'Node']);
    let resolveTypeCalled = false;
    const resolverMap = {
      Query: {
        hello: () => 'Hello',
      },
      Node: {
        __resolveType: () => {
          resolveTypeCalled = true;
          return 'User';
        },
      },
    };

    attachResolvers(schema, resolverMap);

    // Should not throw and __resolveType should be registered
    expect(resolveTypeCalled).toBe(false); // Not called during attachment
  });

  it('attaches __resolveType when type exists', () => {
    const schema = createSchema(['Query', 'Node']);
    const resolverMap = {
      Node: {
        __resolveType: () => 'User',
      },
    };

    // Should not throw - type exists
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
  });
});
