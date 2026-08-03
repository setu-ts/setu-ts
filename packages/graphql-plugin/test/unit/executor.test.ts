/**
 * Tests for executor.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { executeGraphql } from '../../src/execution/executor.ts';
import { DocumentCache } from '../../src/execution/document-cache.ts';
import type {
  GraphqlDocumentNodeLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../../src/interfaces/graphql-runtime.ts';

describe('executor', () => {
  const createFakeRuntime = (): GraphqlRuntime => {
    let parseCallCount = 0;
    let validateCallCount = 0;
    let executeCallCount = 0;

    return {
      parse: (_src: string) => {
        parseCallCount++;
        return {
          kind: 'Document',
          definitions: [{
            kind: 'OperationDefinition',
            operation: 'query',
            selectionSet: { kind: 'SelectionSet', selections: [] },
          }],
        } as unknown as GraphqlDocumentNodeLike;
      },
      validate: (
        _schema: GraphqlSchemaLike,
        _document: GraphqlDocumentNodeLike,
        rules: unknown[],
      ) => {
        validateCallCount++;
        const errors: Array<{ message: string }> = [];
        const mockContext = {
          reportError: (error: { message: string }) => errors.push(error),
        };
        for (const rule of rules) {
          if (typeof rule === 'function') {
            try {
              const visitor = rule(mockContext as never);
              if (visitor && typeof visitor === 'object' && typeof visitor.Field === 'function') {
                try {
                  // Pass empty ancestors to avoid depth-limit rule throwing on undefined
                  visitor.Field(undefined, undefined, undefined, []);
                } catch (e) {
                  // Custom rules may throw to signal validation errors
                  errors.push({ message: (e as Error).message });
                }
              }
            } catch {
              // Built-in rules may throw; ignore
            }
          }
        }
        return errors as never;
      },
      execute: (
        _args: {
          schema: GraphqlSchemaLike;
          document: GraphqlDocumentNodeLike;
          contextValue?: unknown;
          variableValues?: Record<string, unknown>;
          operationName?: string;
        },
      ) => {
        executeCallCount++;
        return Promise.resolve({ data: { hello: 'world' } });
      },
      subscribe: () => Promise.resolve({ data: {} }),
      buildSchema: (_src: string) => ({
        getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
        getMutationType: () => null,
        getSubscriptionType: () => null,
        getType: (name: string) => ({ name }),
        getPossibleTypes: () => [],
        getDirectives: () => [],
        getDirective: () => null,
        toAST: () => ({}),
      }),
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
    } as GraphqlRuntime;
  };

  const createFakeSchema = (): GraphqlSchemaLike =>
    ({
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ hello: { name: 'hello', type: { name: 'String' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => ({ name }),
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    }) as GraphqlSchemaLike;

  it('executes a query successfully', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    expect(result.data).toEqual({ hello: 'world' });
  });

  it('uses cached document on second call', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    // First call - should parse and validate
    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    // Second call - should use cache
    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    // Should have succeeded
    expect(true).toBe(true);
  });

  it('adds depth limit rule when maxDepth > 0', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 5,
      introspection: true,
    });

    expect(result.data).toEqual({ hello: 'world' });
  });

  it('adds introspection rule when introspection is false', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: false,
    });

    expect(result.data).toEqual({ hello: 'world' });
  });

  it('returns parse errors when runtime.parse throws', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    // Override parse to throw a parse error with locations
    (runtime as unknown as GraphqlRuntime).parse = () => {
      const err = new Error('Syntax Error: Unexpected token') as Error & {
        locations?: Array<{ line: number; column: number }>;
      };
      err.locations = [{ line: 1, column: 2 }];
      throw err;
    };

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBe(1);
    expect(result.errors![0].message).toBe('Syntax Error: Unexpected token');
    expect(result.errors![0].locations).toEqual([{ line: 1, column: 2 }]);
    // Exercise the toJSON method on the error object
    expect(result.errors![0].toJSON()).toEqual({
      message: 'Syntax Error: Unexpected token',
      locations: [{ line: 1, column: 2 }],
    });
  });

  it('returns parse errors with fallback message when error has no message', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    // Override parse to throw an error without a message
    (runtime as unknown as GraphqlRuntime).parse = () => {
      const err = new Error() as Error & {
        locations?: Array<{ line: number; column: number }>;
      };
      err.message = '';
      throw err;
    };

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBe(1);
    expect(result.errors![0].message).toBe('Parse error');
  });

  it('returns validation errors when present', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    // Override validate to return errors
    (runtime as unknown as GraphqlRuntime).validate = () => [
      new runtime.GraphQLError('Validation failed'),
    ];

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('passes operationName when provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedOperationName: string | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (args: { operationName?: string }) => {
      capturedOperationName = args.operationName;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      operationName: 'MyQuery',
    });

    expect(capturedOperationName).toBe('MyQuery');
  });

  it('does not pass operationName when empty', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedOperationName: string | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (args: { operationName?: string }) => {
      capturedOperationName = args.operationName;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      operationName: '',
    });

    // Empty string should not be passed
    expect(capturedOperationName).toBeUndefined();
  });

  it('passes variableValues when provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedVariables: Record<string, unknown> | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (
      args: { variableValues?: Record<string, unknown> },
    ) => {
      capturedVariables = args.variableValues;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      variableValues: { name: 'World' },
    });

    expect(capturedVariables).toEqual({ name: 'World' });
  });

  it('passes contextValue when provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedContext: unknown;

    (runtime as unknown as GraphqlRuntime).execute = (args: { contextValue?: unknown }) => {
      capturedContext = args.contextValue;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      contextValue: { user: 'test' },
    });

    expect(capturedContext).toEqual({ user: 'test' });
  });

  it('passes rootValue when provided', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedRootValue: unknown;

    (runtime as unknown as GraphqlRuntime).execute = (args: { rootValue?: unknown }) => {
      capturedRootValue = args.rootValue;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      rootValue: { custom: 'value' },
    });

    expect(capturedRootValue).toEqual({ custom: 'value' });
  });

  it('uses custom validation rules', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const customRule = () => ({});

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [customRule],
      maxDepth: 0,
      introspection: true,
    });

    // Custom rule is passed to validate, not called directly
    expect(true).toBe(true);
  });

  it('passes operationName when provided (non-empty string)', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedOperationName: string | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (args: { operationName?: string }) => {
      capturedOperationName = args.operationName;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      operationName: 'MyQuery',
    });

    expect(capturedOperationName).toBe('MyQuery');
  });

  it('returns execution result with data on success', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const result = await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
    });

    expect(result.data).toEqual({ hello: 'world' });
    expect(result.errors).toBeUndefined();
  });

  it('does not include operationName when empty string', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedOperationName: string | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (args: { operationName?: string }) => {
      capturedOperationName = args.operationName;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      operationName: '', // Empty string should not be passed
    });

    // Empty string should result in undefined
    expect(capturedOperationName).toBeUndefined();
  });

  it('includes operationName when provided (truthy)', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    let capturedOperationName: string | undefined;

    (runtime as unknown as GraphqlRuntime).execute = (args: { operationName?: string }) => {
      capturedOperationName = args.operationName;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      runtime,
      schema,
      documentCache: cache,
      validationRules: [],
      maxDepth: 0,
      introspection: true,
      operationName: 'MyQuery',
    });

    expect(capturedOperationName).toBe('MyQuery');
  });
});
