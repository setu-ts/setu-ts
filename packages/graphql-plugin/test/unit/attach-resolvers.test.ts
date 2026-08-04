/**
 * Tests for attach-resolvers.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { attachResolvers } from '../../src/schema/attach-resolvers.ts';
import { GraphqlSchemaError } from '../../src/errors/graphql-errors.ts';
import type { GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type { FieldResolver } from '../../src/interfaces/options.ts';

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

  it('attaches scalar resolver methods on a type without getFields', () => {
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
        serialize: (v: unknown) => String(v),
        parseValue: (v: unknown) => v,
      },
    };

    // Should not throw — scalar resolvers are attached instead
    attachResolvers(schema, resolverMap);
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

  // N2: enum-skip — a GraphQLEnumType-like object (has `values`, lacks `getFields`/`serialize`)
  // must NOT receive scalar methods attached.
  it('skips enum types — no serialize/parseValue/parseLiteral attached', () => {
    const enumType = {
      name: 'Status',
      values: { ACTIVE: { value: 'ACTIVE' }, INACTIVE: { value: 'INACTIVE' } },
    };
    const schema = {
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({
          status: { name: 'status', type: { name: 'Status' }, args: [] },
        }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => {
        if (name === 'Status') return enumType;
        if (name === 'Query') {
          return {
            name: 'Query',
            getFields: () => ({
              status: { name: 'status', type: { name: 'Status' }, args: [] },
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

    // A bogus "resolver map" that pretends to be a scalar resolver — should be
    // ignored because the type is an enum.
    const resolverMap = {
      Status: {
        serialize: (v: unknown) => v,
        parseValue: (v: unknown) => v,
        parseLiteral: (v: unknown) => v,
      } as unknown as Record<string, unknown>,
    };

    // Must not throw — enum types are skipped by the isEnum branch.
    expect(() => attachResolvers(schema, resolverMap)).not.toThrow();
    // And the enum type must NOT have scalar methods attached.
    expect(typeof (enumType as Record<string, unknown>).serialize).toBe('undefined');
    expect(typeof (enumType as Record<string, unknown>).parseValue).toBe('undefined');
    expect(typeof (enumType as Record<string, unknown>).parseLiteral).toBe('undefined');
  });
});

describe('attachResolvers — a malformed field entry', () => {
  it('throws a named error rather than assigning a non-function to resolve', () => {
    // Before subscription support this silently assigned whatever it was
    // given, which is how a `{ subscribe }` entry ended up on `resolve` with
    // `subscribe` left unset. Anything that is neither a function nor a
    // subscription resolver is now refused at registration.
    const schema = {
      getType: (name: string) =>
        name === 'Query'
          ? {
            name: 'Query',
            getFields: () => ({ hello: { name: 'hello', args: [] } }),
            getInterfaces: () => [],
          }
          : null,
    } as unknown as GraphqlSchemaLike;

    expect(() =>
      attachResolvers(schema, {
        Query: { hello: { nonsense: true } as unknown as FieldResolver },
      })
    ).toThrow(/must be a function/);
  });
});
