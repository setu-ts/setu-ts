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

  it('leaves every field untouched for an empty resolver map', () => {
    const schema = createSchema(['Query']);
    const before = Object.values(schema.getQueryType()!.getFields()).map((f) => f.resolve);

    attachResolvers(schema, {});

    const after = Object.values(schema.getQueryType()!.getFields()).map((f) => f.resolve);
    expect(after).toEqual(before);
    expect(after.every((r) => r === undefined)).toBe(true);
  });

  it('attaches __resolveType to interface types (B5)', () => {
    // Create a proper interface type with resolveType property
    const interfaceType = {
      name: 'Node',
      getFields: () => ({ id: { name: 'id', type: { name: 'ID' }, args: [] } }),
      resolveType: undefined as unknown,
    };

    const schema = {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ node: { name: 'node', type: { name: 'Node' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (name === 'Node') {
          return interfaceType;
        }
        if (name === 'Query') {
          return {
            name: 'Query',
            getFields: () => ({ node: { name: 'node', type: { name: 'Node' }, args: [] } }),
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

    const resolveTypeFn = () => 'User';
    const resolverMap = {
      Node: {
        __resolveType: resolveTypeFn,
      },
    };

    attachResolvers(schema, resolverMap);

    // B5: verify __resolveType is attached to the interface type
    expect(interfaceType.resolveType).toBe(resolveTypeFn);
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

  it('attaches __resolveType to union types (no getFields)', () => {
    // Union types don't have getFields
    const unionType = {
      name: 'SearchResult',
      resolveType: undefined as unknown,
    };

    const schema = {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ search: { name: 'search', type: { name: 'SearchResult' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (name === 'SearchResult') {
          return unionType;
        }
        if (name === 'Query') {
          return {
            name: 'Query',
            getFields: () => ({
              search: { name: 'search', type: { name: 'SearchResult' }, args: [] },
            }),
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

    const resolveTypeFn = () => 'User';
    const resolverMap = {
      SearchResult: {
        __resolveType: resolveTypeFn,
      },
    };

    attachResolvers(schema, resolverMap);

    // Union type should also get resolveType attached
    expect(unionType.resolveType).toBe(resolveTypeFn);
  });

  it('skips __resolveType when not a function', () => {
    const schema = createSchema(['Query']);
    const resolverMap = {
      Query: {
        hello: () => 'Hello',
        __resolveType: 'not-a-function' as unknown as () => string,
      },
    };

    // Should not throw - non-function __resolveType is skipped
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
  });

  it('handles type that exists but has wrong kind for __resolveType', () => {
    // A scalar type exists but doesn't have getFields
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
          // Scalar type - no getFields, but truthy
          return { name: 'String' };
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
        __resolveType: () => 'User',
      },
    };

    // Should not throw - scalar types are skipped in the second loop
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
  });
});
