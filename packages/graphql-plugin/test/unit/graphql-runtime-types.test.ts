/**
 * Runtime round-trip for X6-3 (M70i): the adapted real `graphql` module
 * behaves like the facade it is cast to.
 *
 * The companion type fixture `test/types/real-graphql-types.ts` proves the
 * static assignability; this proves the adapted module actually parses and
 * executes a real document at runtime.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { adaptGraphqlModule } from '../../src/runtime/graphql-loader.ts';

describe('adapted real graphql runtime round-trip', () => {
  it('parses, builds a schema, and executes a real query', async () => {
    let graphql: typeof import('npm:graphql') | null = null;
    try {
      graphql = await import('npm:graphql@^16');
    } catch (_e) {
      return; // skip when the npm cache is cold / offline
    }

    const runtime = adaptGraphqlModule(graphql!);

    // parse round-trips a real document
    const document = runtime.parse('{ hello }');
    expect(document).toBeDefined();
    expect(document.kind).toBe('Document');
    expect(Array.isArray(document.definitions)).toBe(true);

    // buildSchema round-trips a real schema
    const schema = runtime.buildSchema('type Query { hello: String }');
    expect(schema).toBeDefined();
    expect(schema.getQueryType()?.name).toBe('Query');

    // execute round-trips a real result through the adapted facade
    const result = await runtime.execute({
      schema,
      document: runtime.parse('{ hello }'),
      rootValue: { hello: () => 'Hello World' },
      contextValue: {},
      variableValues: {},
    });
    expect(result).toEqual({ data: { hello: 'Hello World' } });
  });
});
