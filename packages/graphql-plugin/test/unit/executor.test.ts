/**
 * Tests for executor.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { checkOperation, executeGraphql } from '../../src/execution/executor.ts';
import { DocumentCache } from '../../src/execution/document-cache.ts';
import type {
  GraphqlDocumentNodeLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../../src/interfaces/graphql-runtime.ts';

interface RuntimeCounters {
  parse: number;
  validate: number;
  execute: number;
}

/**
 * A fake runtime whose `getOperationAST` reflects the operation kind recorded on
 * the document its `parse` produced — the real module's behaviour, which the
 * operation guard depends on.
 */
const createFakeRuntime = (
  operation: 'query' | 'mutation' | 'subscription' = 'query',
): GraphqlRuntime & { counters: RuntimeCounters } => {
  const counters: RuntimeCounters = { parse: 0, validate: 0, execute: 0 };

  const runtime = {
    counters,
    parse: (_src: string) => {
      counters.parse++;
      return {
        kind: 'Document',
        definitions: [{
          kind: 'OperationDefinition',
          operation,
          selectionSet: { kind: 'SelectionSet', selections: [] },
        }],
      } as unknown as GraphqlDocumentNodeLike;
    },
    validate: (
      _schema: GraphqlSchemaLike,
      _document: GraphqlDocumentNodeLike,
      _rules: unknown[],
    ) => {
      counters.validate++;
      return [] as never;
    },
    execute: (_args: { operationName?: string }) => {
      counters.execute++;
      return Promise.resolve({ data: { hello: 'world' } });
    },
    subscribe: () => Promise.resolve({ data: {} }),
    buildSchema: (_src: string) => createFakeSchema(),
    validateSchema: () => [],
    getOperationAST: (document: GraphqlDocumentNodeLike) => document.definitions[0] ?? null,
    GraphQLError: class extends Error {
      override name = 'GraphQLError';
      toJSON() {
        return { message: this.message };
      }
    },
    NoSchemaIntrospectionCustomRule: {},
    specifiedRules: [],
  } as unknown as GraphqlRuntime & { counters: RuntimeCounters };

  return runtime;
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

const baseOptions = (runtime: GraphqlRuntime, cache: DocumentCache) => ({
  runtime,
  schema: createFakeSchema(),
  documentCache: cache,
  validationRules: [],
});

describe('executor', () => {
  it('executes a query and reports status 200 with executed true', async () => {
    const runtime = createFakeRuntime();
    const outcome = await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    expect(outcome.status).toBe(200);
    expect(outcome.executed).toBe(true);
    expect(outcome.result.data).toEqual({ hello: 'world' });
    expect(outcome.result.errors).toBeUndefined();
  });

  it('parses and validates once across repeated identical queries', async () => {
    const runtime = createFakeRuntime();
    const cache = new DocumentCache(100);

    for (let i = 0; i < 4; i++) {
      await executeGraphql('{ hello }', baseOptions(runtime, cache));
    }

    // The cache holds the document AND its validation result, and the operation
    // guard reads the cached AST rather than re-parsing.
    expect(runtime.counters.parse).toBe(1);
    expect(runtime.counters.validate).toBe(1);
    expect(runtime.counters.execute).toBe(4);
  });

  it('re-parses every request when the cache is disabled', async () => {
    const runtime = createFakeRuntime();
    const cache = new DocumentCache(0);

    await executeGraphql('{ hello }', baseOptions(runtime, cache));
    await executeGraphql('{ hello }', baseOptions(runtime, cache));

    expect(runtime.counters.parse).toBe(2);
    expect(runtime.counters.validate).toBe(2);
  });

  it('returns a 400 parse error carrying locations when parse throws', async () => {
    const runtime = createFakeRuntime();
    runtime.parse = () => {
      const err = new Error('Syntax Error: Unexpected token') as Error & {
        locations?: Array<{ line: number; column: number }>;
      };
      err.locations = [{ line: 1, column: 2 }];
      throw err;
    };

    const outcome = await executeGraphql('{ hello', baseOptions(runtime, new DocumentCache(100)));

    expect(outcome.status).toBe(400);
    expect(outcome.executed).toBe(false);
    expect(outcome.result.errors?.length).toBe(1);
    expect(outcome.result.errors![0].message).toBe('Syntax Error: Unexpected token');
    expect(outcome.result.errors![0].locations).toEqual([{ line: 1, column: 2 }]);
    expect(outcome.result.errors![0].toJSON()).toEqual({
      message: 'Syntax Error: Unexpected token',
      locations: [{ line: 1, column: 2 }],
    });
  });

  it('falls back to a generic parse message when the thrown error has none', async () => {
    const runtime = createFakeRuntime();
    runtime.parse = () => {
      const err = new Error();
      err.message = '';
      throw err;
    };

    const outcome = await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    expect(outcome.status).toBe(400);
    expect(outcome.result.errors![0].message).toBe('Parse error');
    expect(outcome.result.errors![0].toJSON()).toEqual({ message: 'Parse error' });
  });

  it('does not validate or execute when parse fails', async () => {
    const runtime = createFakeRuntime();
    runtime.parse = () => {
      throw new Error('boom');
    };

    await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    expect(runtime.counters.validate).toBe(0);
    expect(runtime.counters.execute).toBe(0);
  });

  it('returns a 400 with the validation errors and never executes', async () => {
    const runtime = createFakeRuntime();
    runtime.validate = () => [new runtime.GraphQLError('Validation failed')] as never;

    const outcome = await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    expect(outcome.status).toBe(400);
    expect(outcome.executed).toBe(false);
    expect(outcome.result.errors?.length).toBe(1);
    expect(outcome.result.errors![0].message).toBe('Validation failed');
    expect(runtime.counters.execute).toBe(0);
  });

  it('reuses cached validation errors without re-validating', async () => {
    const runtime = createFakeRuntime();
    const cache = new DocumentCache(100);
    runtime.validate = () => {
      runtime.counters.validate++;
      return [new runtime.GraphQLError('Validation failed')] as never;
    };

    const first = await executeGraphql('{ hello }', baseOptions(runtime, cache));
    const second = await executeGraphql('{ hello }', baseOptions(runtime, cache));

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(second.result.errors?.length).toBe(1);
    expect(runtime.counters.validate).toBe(1);
  });

  it('reports 200 with executed true when a field error nulls data', async () => {
    const runtime = createFakeRuntime();
    runtime.execute = () =>
      Promise.resolve({
        data: null,
        errors: [{ message: 'resolver blew up' }] as never,
      });

    const outcome = await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    // The operation ran. A field error is not a request error, so this must not
    // become a 400 even under strict negotiation.
    expect(outcome.status).toBe(200);
    expect(outcome.executed).toBe(true);
    expect(outcome.result.data).toBeNull();
    expect(outcome.result.errors?.length).toBe(1);
  });

  it('refuses a subscription over HTTP with a coded 400', async () => {
    const runtime = createFakeRuntime('subscription');
    const outcome = await executeGraphql(
      'subscription { hello }',
      baseOptions(runtime, new DocumentCache(100)),
    );

    expect(outcome.status).toBe(400);
    expect(outcome.executed).toBe(false);
    expect(outcome.result.errors![0].extensions?.code).toBe(
      'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP',
    );
    expect(runtime.counters.validate).toBe(0);
    expect(runtime.counters.execute).toBe(0);
  });

  it('refuses a mutation over GET with a coded 405, but allows it over POST', async () => {
    const cache = new DocumentCache(100);
    const getRuntime = createFakeRuntime('mutation');
    const refused = await executeGraphql('mutation { m }', {
      ...baseOptions(getRuntime, cache),
      method: 'GET',
    });

    expect(refused.status).toBe(405);
    expect(refused.executed).toBe(false);
    expect(refused.result.errors![0].extensions?.code).toBe('METHOD_NOT_ALLOWED');
    expect(getRuntime.counters.execute).toBe(0);

    const postRuntime = createFakeRuntime('mutation');
    const allowed = await executeGraphql('mutation { m }', {
      ...baseOptions(postRuntime, new DocumentCache(100)),
      method: 'POST',
    });

    expect(allowed.status).toBe(200);
    expect(postRuntime.counters.execute).toBe(1);
  });

  it('reports OPERATION_RESOLUTION_FAILED when the operation cannot be resolved', async () => {
    const runtime = createFakeRuntime();
    runtime.getOperationAST = () => null;

    const outcome = await executeGraphql(
      'query A { hello } query B { hello }',
      baseOptions(runtime, new DocumentCache(100)),
    );

    expect(outcome.status).toBe(400);
    expect(outcome.executed).toBe(false);
    expect(outcome.result.errors![0].extensions?.code).toBe('OPERATION_RESOLUTION_FAILED');
    expect(outcome.result.errors![0].toJSON().extensions?.code).toBe(
      'OPERATION_RESOLUTION_FAILED',
    );
    expect(runtime.counters.validate).toBe(0);
  });

  it('passes operationName through only when it is non-empty', async () => {
    const captured: Array<string | undefined> = [];
    const runtime = createFakeRuntime();
    runtime.execute = (args: { operationName?: string }) => {
      captured.push(args.operationName);
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      ...baseOptions(runtime, new DocumentCache(100)),
      operationName: 'MyQuery',
    });
    await executeGraphql('{ hello }', {
      ...baseOptions(runtime, new DocumentCache(100)),
      operationName: '',
    });

    expect(captured).toEqual(['MyQuery', undefined]);
  });

  it('passes variableValues, contextValue and rootValue through to execute', async () => {
    const runtime = createFakeRuntime();
    let args: {
      variableValues?: Record<string, unknown>;
      contextValue?: unknown;
      rootValue?: unknown;
    } = {};
    runtime.execute = (received) => {
      args = received;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', {
      ...baseOptions(runtime, new DocumentCache(100)),
      variableValues: { name: 'World' },
      contextValue: { user: 'test' },
      rootValue: { custom: 'value' },
    });

    expect(args.variableValues).toEqual({ name: 'World' });
    expect(args.contextValue).toEqual({ user: 'test' });
    expect(args.rootValue).toEqual({ custom: 'value' });
  });

  it('defaults variableValues to an empty object when absent', async () => {
    const runtime = createFakeRuntime();
    let captured: Record<string, unknown> | undefined;
    runtime.execute = (args: { variableValues?: Record<string, unknown> }) => {
      captured = args.variableValues;
      return Promise.resolve({ data: { hello: 'world' } });
    };

    await executeGraphql('{ hello }', baseOptions(runtime, new DocumentCache(100)));

    expect(captured).toEqual({});
  });

  it('hands the assembled rule list to validate verbatim', async () => {
    const runtime = createFakeRuntime();
    const customRule = () => ({});
    let receivedRules: unknown[] | undefined;
    runtime.validate = (_s, _d, rules) => {
      receivedRules = rules;
      return [] as never;
    };

    await executeGraphql('{ hello }', {
      ...baseOptions(runtime, new DocumentCache(100)),
      validationRules: [customRule],
    });

    expect(receivedRules).toEqual([customRule]);
  });

  describe('checkOperation', () => {
    it('returns null for a query, letting execution continue', () => {
      const runtime = createFakeRuntime();
      const document = runtime.parse('{ hello }');

      expect(checkOperation(runtime, document, { transport: 'http' })).toBeNull();
    });

    it('treats an empty operationName as absent', () => {
      const runtime = createFakeRuntime();
      let received: string | undefined = 'sentinel';
      runtime.getOperationAST = (document, name) => {
        received = name;
        return document.definitions[0] ?? null;
      };
      const document = runtime.parse('{ hello }');

      checkOperation(runtime, document, { operationName: '', transport: 'http' });

      expect(received).toBeUndefined();
    });

    it('forwards a non-empty operationName', () => {
      const runtime = createFakeRuntime();
      let received: string | undefined;
      runtime.getOperationAST = (document, name) => {
        received = name;
        return document.definitions[0] ?? null;
      };
      const document = runtime.parse('query A { hello }');

      checkOperation(runtime, document, { operationName: 'A', transport: 'http' });

      expect(received).toBe('A');
    });
  });
});
