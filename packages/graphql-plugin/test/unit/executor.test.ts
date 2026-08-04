/**
 * Tests for execution/executor.ts
 *
 * Directly exercises the shared `prepareDocument` prologue and the
 * `checkOperation` operation-kind guard across both transport arms (`'http'`
 * and `'stream'`). These seams are exported but the only in-repo caller of the
 * `'http'` arm is `executeGraphql`; the `'stream'` arm and `prepareDocument`
 * itself are reached here so the per-file function-coverage bar holds.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  checkOperation,
  codedError,
  executeGraphql,
  prepareDocument,
  toParseError,
} from '../../src/execution/executor.ts';
import { DocumentCache } from '../../src/execution/document-cache.ts';
import type {
  GraphqlDefinitionNodeLike,
  GraphqlDocumentNodeLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../../src/interfaces/graphql-runtime.ts';

/** Build a fake runtime with a controllable operation AST and parse/validate. */
function createRuntime(opts: {
  operation?: { operation: string } | null;
  /** When set, the SECOND `getOperationAST` call returns this (null included). */
  operationSecond?: { operation: string } | null;
  parseThrows?: boolean;
  validationErrors?: unknown[];
} = {}): GraphqlRuntime {
  let astCallCount = 0;
  return {
    parse: (_src: string) => {
      if (opts.parseThrows) throw new Error('syntax error');
      return { kind: 'Document', definitions: [] } as unknown as GraphqlDocumentNodeLike;
    },
    validate: () => (opts.validationErrors ?? []) as never,
    execute: () => Promise.resolve({ data: { ok: true } }),
    subscribe: () => Promise.resolve({ data: {} }),
    buildSchema: (_src: string) => ({} as unknown as GraphqlSchemaLike),
    validateSchema: () => [],
    getOperationAST: () => {
      astCallCount++;
      if (astCallCount === 1) return (opts.operation ?? null) as GraphqlDefinitionNodeLike;
      // Distinguish "not provided" from "explicitly null": `null ?? x` would
      // otherwise coalesce back to `operation`.
      return (opts.operationSecond !== undefined
        ? opts.operationSecond
        : (opts.operation ?? null)) as GraphqlDefinitionNodeLike;
    },
    GraphQLError: class extends Error {
      override name = 'GraphQLError';
      toJSON() {
        return { message: this.message };
      }
    },
    NoSchemaIntrospectionCustomRule: {},
    specifiedRules: [],
  } as unknown as GraphqlRuntime;
}

describe('codedError', () => {
  it('builds a coded error that serializes to {message,extensions:{code}}', () => {
    const err = codedError('nope', 'NOPE_CODE');
    expect(err.message).toBe('nope');
    expect(err.extensions).toEqual({ code: 'NOPE_CODE' });
    expect(err.toJSON()).toEqual({ message: 'nope', extensions: { code: 'NOPE_CODE' } });
  });
});

describe('toParseError', () => {
  it('passes through a graphql error message and locations', () => {
    const err = toParseError({
      message: 'Syntax Error: unexpected `}`',
      locations: [{ line: 1, column: 2 }],
    });
    expect(err.message).toBe('Syntax Error: unexpected `}`');
    expect(err.locations).toEqual([{ line: 1, column: 2 }]);
    expect(err.toJSON()).toEqual({
      message: 'Syntax Error: unexpected `}`',
      locations: [{ line: 1, column: 2 }],
    });
  });

  it('substitutes a default message when none is present', () => {
    const err = toParseError({ message: '' });
    expect(err.message).toBe('Parse error');
    expect(err.toJSON()).toEqual({ message: 'Parse error' });
  });

  it('substitutes a default message for a non-error throw', () => {
    const err = toParseError('a bare string');
    expect(err.message).toBe('Parse error');
  });
});

describe('checkOperation', () => {
  it('refuses an unresolvable operation (OPERATION_RESOLUTION_FAILED)', () => {
    const runtime = createRuntime({ operation: null });
    const outcome = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(outcome).not.toBeNull();
    expect((outcome as { refused: boolean }).refused).toBe(true);
    const result =
      (outcome as unknown as { result: { errors: Array<{ extensions: { code: string } }> } })
        .result;
    expect(result.errors[0].extensions.code).toBe('OPERATION_RESOLUTION_FAILED');
  });

  it('http arm refuses a subscription (SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP)', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    const outcome = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(outcome).not.toBeNull();
    const o = outcome as unknown as {
      status: number;
      executed: boolean;
      result: { errors: Array<{ extensions: { code: string } }> };
    };
    expect(o.status).toBe(400);
    expect(o.executed).toBe(false);
    expect(o.result.errors[0].extensions.code).toBe('SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP');
  });

  it('http arm refuses a mutation over GET (METHOD_NOT_ALLOWED, 405)', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    const outcome = checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'http',
      method: 'GET',
    });
    const o = outcome as unknown as {
      status: number;
      executed: boolean;
      result: { errors: Array<{ extensions: { code: string } }> };
    };
    expect(o.status).toBe(405);
    expect(o.executed).toBe(false);
    expect(o.result.errors[0].extensions.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('http arm allows a query (returns null)', () => {
    const runtime = createRuntime({ operation: { operation: 'query' } });
    expect(checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' }))
      .toBeNull();
  });

  it('http arm allows a mutation over POST (returns null)', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    expect(
      checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http', method: 'POST' }),
    ).toBeNull();
  });

  it('stream arm does not refuse a subscription (returns null)', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    expect(
      checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'stream' }),
    ).toBeNull();
  });

  it('stream arm does not refuse a mutation over GET (returns null)', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    expect(
      checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
        transport: 'stream',
        method: 'GET',
      }),
    ).toBeNull();
  });

  it('passes operationName through to getOperationAST only when non-empty', () => {
    let seenName: unknown = 'untouched';
    const runtime = {
      getOperationAST: (_d: unknown, name: unknown) => {
        seenName = name;
        return { operation: 'query' };
      },
    } as unknown as GraphqlRuntime;
    checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'http',
      operationName: 'MyQuery',
    });
    expect(seenName).toBe('MyQuery');

    checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'http',
      operationName: '',
    });
    expect(seenName).toBeUndefined();
  });
});

describe('prepareDocument', () => {
  it('returns null when the query fails to parse', () => {
    const runtime = createRuntime({ parseThrows: true, operation: { operation: 'query' } });
    const cache = new DocumentCache(10);
    expect(prepareDocument('{ x }', runtime, cache, [], { transport: 'http' })).toBeNull();
  });

  it('returns a PreparedRefusal when the http guard refuses (subscription)', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    const cache = new DocumentCache(10);
    const result = prepareDocument('subscription { x }', runtime, cache, [], { transport: 'http' });
    expect((result as { refused?: boolean }).refused).toBe(true);
  });

  it('returns a PreparedDocument on a cache hit and does not re-validate', () => {
    const document = { kind: 'Document', definitions: [] };
    const cachedErrors = [{ message: 'cached' }];
    const runtime = createRuntime({ operation: { operation: 'query' } });
    const cache = new DocumentCache(10);
    cache.set('{ x }', {
      document: document as unknown as GraphqlDocumentNodeLike,
      validationErrors: cachedErrors as never,
    });
    const validateSpy: string[] = [];
    (runtime as unknown as { validate: () => unknown[] }).validate = () => {
      validateSpy.push('called');
      return [];
    };

    const result = prepareDocument('{ x }', runtime, cache, [], { transport: 'http' });
    expect((result as { document?: unknown }).document).toBe(document);
    // Cached validation result is reused; validate is not invoked.
    expect(validateSpy).toEqual([]);
  });

  it('validates and caches on a cache miss', () => {
    const runtime = createRuntime({ operation: { operation: 'query' } });
    const cache = new DocumentCache(10);
    let validateCalls = 0;
    (runtime as unknown as { validate: () => unknown[] }).validate = () => {
      validateCalls++;
      return [];
    };

    const first = prepareDocument('{ x }', runtime, cache, [], { transport: 'http' });
    expect((first as { document?: unknown }).document).toBeDefined();
    expect(validateCalls).toBe(1);
    expect(cache.size).toBe(1);

    // Second call for the same query hits the cache → no second validate.
    prepareDocument('{ x }', runtime, cache, [], { transport: 'http' });
    expect(validateCalls).toBe(1);
  });

  it('refuses when the operation cannot be resolved after validation', () => {
    // First getOperationAST call (inside checkOperation) resolves to a query,
    // the second (after validate) returns null → OPERATION_RESOLUTION_FAILED.
    const runtime = createRuntime({
      operation: { operation: 'query' },
      operationSecond: null,
    });
    const cache = new DocumentCache(10);
    const result = prepareDocument('{ x }', runtime, cache, [], { transport: 'http' });
    expect((result as { refused?: boolean }).refused).toBe(true);
    const errors =
      (result as unknown as { result: { errors: Array<{ extensions: { code: string } }> } }).result
        .errors;
    expect(errors[0].extensions.code).toBe('OPERATION_RESOLUTION_FAILED');
  });

  it('uses the stream transport so a subscription is not refused', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    const cache = new DocumentCache(10);
    const result = prepareDocument('subscription { x }', runtime, cache, [], {
      transport: 'stream',
    });
    expect((result as { operation?: { operation: string } }).operation?.operation).toBe(
      'subscription',
    );
  });
});

describe('executeGraphql', () => {
  it('returns a 400 parse-error outcome when the query does not parse', async () => {
    const runtime = createRuntime({ parseThrows: true, operation: { operation: 'query' } });
    const cache = new DocumentCache(10);
    const outcome = await executeGraphql('{ x }', {
      schema: {} as GraphqlSchemaLike,
      runtime,
      documentCache: cache,
      validationRules: [],
    });
    expect(outcome.status).toBe(400);
    expect(outcome.executed).toBe(false);
    expect(outcome.result.errors).toBeDefined();
  });
});
