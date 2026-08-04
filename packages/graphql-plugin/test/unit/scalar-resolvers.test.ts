/**
 * Tests for schema/attach-resolvers.ts scalar branch
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { attachResolvers } from '../../src/schema/attach-resolvers.ts';
import type { GraphqlRuntime } from '../../src/interfaces/graphql-runtime.ts';

/** Shape of a custom scalar type produced by the fake runtime's buildSchema. */
interface ScalarLike {
  serialize: () => unknown;
  parseValue: (value?: unknown) => unknown;
  parseLiteral: (node?: unknown) => unknown;
}

/** Shape of a field map returned by `getQueryType().getFields()`. */
interface FieldsLike {
  hello: { resolve: (...args: unknown[]) => unknown };
}

const createFakeRuntime = (): GraphqlRuntime =>
  ({
    parse: () => ({ kind: 'Document', definitions: [] }),
    validate: () => [],
    execute: () => Promise.resolve({ data: {} }),
    subscribe: () => Promise.resolve({ data: {} }),
    buildSchema: (src: string) => {
      // Extract scalar declarations from schema string
      const scalarMatch = src.match(/scalar\s+(\w+)/);
      const hasScalar = scalarMatch !== null;
      const scalarType = hasScalar
        ? {
          name: scalarMatch[1],
          kind: 'SCALAR',
          serialize: () => 'default',
          parseValue: () => 'default',
          parseLiteral: () => null,
        }
        : null;

      // Extract Query fields from schema string (e.g. "type Query { hello: String }")
      const fields: Record<string, { name: string; type: () => unknown; args: unknown[] }> = {};
      const queryBlockMatch = src.match(/type\s+Query\s*\{([^}]+)\}/);
      if (queryBlockMatch) {
        const fieldDefs = queryBlockMatch[1].trim();
        // Parse each field: "fieldName: FieldType"
        for (const line of fieldDefs.split('\n')) {
          const trimmed = line.trim().replace(/;$/, '');
          if (!trimmed) continue;
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx < 0) continue;
          const fname = trimmed.slice(0, colonIdx).trim();
          const ftype = trimmed.slice(colonIdx + 1).trim();
          fields[fname] = {
            name: fname,
            type: () => ({ name: ftype }),
            args: [],
          };
        }
      }

      const queryType = {
        name: 'Query',
        getFields: () => fields,
        getInterfaces: () => [],
      };
      return {
        getQueryType: () => queryType,
        getMutationType: () => null,
        getSubscriptionType: () => null,
        getType: (name: string) => {
          if (name === 'DateTime' && scalarType) return scalarType;
          // N2: String is a built-in scalar — give it the scalar methods so
          // the attach-resolvers scalar discriminator recognizes it.
          if (name === 'String') {
            return {
              name: 'String',
              kind: 'SCALAR',
              serialize: (v: unknown) => v,
              parseValue: (v: unknown) => v,
              parseLiteral: (v: unknown) => v,
            };
          }
          if (name === 'Query') return queryType;
          return null;
        },
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
  }) as unknown as GraphqlRuntime;

describe('attachResolvers — scalar', () => {
  it('attaches serialize method to scalar type', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { now: DateTime } scalar DateTime');

    attachResolvers(schema, {
      DateTime: {
        serialize: () => 'custom-serialized',
      },
    });

    const scalar = schema.getType('DateTime');
    expect(scalar).not.toBeNull();
    const result = (scalar as unknown as ScalarLike).serialize();
    expect(result).toBe('custom-serialized');
  });

  it('attaches parseValue method to scalar type', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { now: DateTime } scalar DateTime');

    attachResolvers(schema, {
      DateTime: {
        parseValue: () => new Date('2024-01-01'),
      },
    });

    const scalar = schema.getType('DateTime');
    const result = (scalar as unknown as ScalarLike).parseValue('2024-01-01');
    expect(result).toBeInstanceOf(Date);
  });

  it('attaches parseLiteral method to scalar type', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { now: DateTime } scalar DateTime');

    attachResolvers(schema, {
      DateTime: {
        parseLiteral: () => 'from-literal',
      },
    });

    const scalar = schema.getType('DateTime');
    const result = (scalar as unknown as ScalarLike).parseLiteral({
      kind: 'StringValue',
      value: '2024-01-01',
    });
    expect(result).toBe('from-literal');
  });

  it('attaches all three methods', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { now: DateTime } scalar DateTime');

    attachResolvers(schema, {
      DateTime: {
        serialize: () => 's',
        parseValue: () => 'p',
        parseLiteral: () => 'l',
      },
    });

    const scalar = schema.getType('DateTime');
    expect((scalar as unknown as ScalarLike).serialize()).toBe('s');
    expect((scalar as unknown as ScalarLike).parseValue()).toBe('p');
    expect((scalar as unknown as ScalarLike).parseLiteral()).toBe('l');
  });

  it('omitted members leave graphql default', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { now: DateTime } scalar DateTime');

    // Only attach serialize
    attachResolvers(schema, {
      DateTime: {
        serialize: () => 'custom',
      },
    });

    const scalar = schema.getType('DateTime');
    expect((scalar as unknown as ScalarLike).serialize()).toBe('custom');
    // parseValue should still be the default
    expect((scalar as unknown as ScalarLike).parseValue()).toBe('default');
  });

  it('object type field resolvers still work', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { hello: String } scalar DateTime');

    attachResolvers(schema, {
      Query: {
        hello: () => 'resolvers work',
      },
    });

    const queryType = schema.getQueryType();
    const fields = queryType!.getFields();
    const helloResolver = (fields as unknown as FieldsLike).hello.resolve;
    expect(typeof helloResolver).toBe('function');
    expect(helloResolver(null, {}, {}, {})).toBe('resolvers work');
  });

  it('unknown type name throws', () => {
    const runtime = createFakeRuntime();
    const schema = runtime.buildSchema('type Query { hello: String }');

    expect(() => {
      attachResolvers(schema, {
        NonExistentType: {
          serialize: () => 'no',
        },
      });
    }).toThrow();
  });
});
