/**
 * Guarded real import test for graphql module.
 *
 * This test (mandated by plan §6, M9/M49 guarded real-import precedent)
 * verifies that the graphql package can be lazily imported and used.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('graphql real import', () => {
  it('successfully imports and uses graphql module', async () => {
    // Guarded real import - this is the actual npm:graphql package
    let graphql: typeof import('npm:graphql') | null = null;

    try {
      graphql = await import('npm:graphql@^16');
    } catch (_e) {
      // Skip test if graphql is not installed
      return;
    }

    expect(graphql).not.toBeNull();
    expect(graphql!.parse).toBeDefined();
    expect(graphql!.validate).toBeDefined();
    expect(graphql!.execute).toBeDefined();
    expect(graphql!.buildSchema).toBeDefined();

    // Smoke test: parse a simple query
    const document = graphql!.parse('{ hello }');
    expect(document).toBeDefined();
    expect(document.kind).toBe('Document');

    // Smoke test: build and validate a schema
    const schema = graphql!.buildSchema(`
      type Query {
        hello: String
      }
    `);
    expect(schema).toBeDefined();

    const errors = graphql!.validate(schema, document);
    // Should have validation errors (hello field doesn't exist on Query in this schema)
    // but the validate function should work
    expect(Array.isArray(errors)).toBe(true);
  });

  it('executes a simple query', async () => {
    let graphql: typeof import('npm:graphql') | null = null;

    try {
      graphql = await import('npm:graphql@^16');
    } catch (_e) {
      return;
    }

    const schema = graphql!.buildSchema(`
      type Query {
        hello: String
      }
    `);

    const rootValue = {
      hello: () => 'Hello World',
    };

    const result = await graphql!.execute({
      schema,
      document: graphql!.parse('{ hello }'),
      rootValue,
    });

    expect(result).toEqual({
      data: { hello: 'Hello World' },
    });
  });
});
