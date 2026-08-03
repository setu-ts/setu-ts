/**
 * Tests for graphql-errors.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GraphqlRuntimeLoadError, GraphqlSchemaError } from '../../src/errors/graphql-errors.ts';

describe('GraphqlSchemaError', () => {
  it('has correct name', () => {
    const error = new GraphqlSchemaError('Test error');
    expect(error.name).toBe('GraphqlSchemaError');
  });

  it('preserves message', () => {
    const error = new GraphqlSchemaError('Schema is invalid');
    expect(error.message).toBe('Schema is invalid');
  });

  it('preserves cause', () => {
    const cause = new Error('Original cause');
    const error = new GraphqlSchemaError('Schema is invalid', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('GraphqlRuntimeLoadError', () => {
  it('has correct name', () => {
    const error = new GraphqlRuntimeLoadError('npm:graphql@^16', new Error('Failed'));
    expect(error.name).toBe('GraphqlRuntimeLoadError');
  });

  it('includes specifier', () => {
    const error = new GraphqlRuntimeLoadError('npm:graphql@^16', new Error('Failed'));
    expect(error.specifier).toBe('npm:graphql@^16');
  });

  it('includes install command in message', () => {
    const error = new GraphqlRuntimeLoadError('npm:graphql@^16', new Error('Failed'));
    expect(error.message).toContain('deno add npm:graphql@^16');
  });

  it('preserves cause', () => {
    const cause = new Error('Import failed');
    const error = new GraphqlRuntimeLoadError('npm:graphql@^16', cause);
    expect(error.cause).toBe(cause);
  });
});
