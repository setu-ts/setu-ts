/**
 * Tests for execution/executor.ts
 *
 * Exercises the `checkOperation` operation-kind guard across both transport
 * arms (`'http'` and `'stream'`) and the `executeGraphql` pipeline.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  checkOperation,
  codedError,
  executeGraphql,
  toInternalError,
  toParseError,
} from '../../src/execution/executor.ts';
import { isExposable } from '../../src/security/mask-errors.ts';
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
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(check.refused).not.toBeNull();
    expect(check.refused?.status).toBe(400);
    expect(check.refused?.executed).toBe(false);
    const errors = check.refused?.result.errors ?? [];
    expect(errors[0]?.extensions?.code).toBe('OPERATION_RESOLUTION_FAILED');
  });

  it('http arm refuses a subscription (SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP)', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(check.refused?.status).toBe(400);
    expect(check.refused?.executed).toBe(false);
    expect(check.refused?.result.errors?.[0]?.extensions?.code).toBe(
      'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP',
    );
  });

  it('http arm refuses a mutation over GET (METHOD_NOT_ALLOWED, 405)', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'http',
      method: 'GET',
    });
    expect(check.refused?.status).toBe(405);
    expect(check.refused?.executed).toBe(false);
    expect(check.refused?.result.errors?.[0]?.extensions?.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('http arm allows a query and reports its kind', () => {
    const runtime = createRuntime({ operation: { operation: 'query' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(check.refused).toBeNull();
    expect(check.refused === null ? check.operation : null).toBe('query');
  });

  it('http arm allows a mutation over POST and reports its kind', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'http',
      method: 'POST',
    });
    expect(check.refused).toBeNull();
    expect(check.refused === null ? check.operation : null).toBe('mutation');
  });

  it('stream arm allows a subscription and reports its kind', () => {
    const runtime = createRuntime({ operation: { operation: 'subscription' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'stream' });
    expect(check.refused).toBeNull();
    // The kind is what lets `subscribeGraphql` dispatch without a second
    // `getOperationAST` walk.
    expect(check.refused === null ? check.operation : null).toBe('subscription');
  });

  it('stream arm does not refuse a mutation over GET', () => {
    const runtime = createRuntime({ operation: { operation: 'mutation' } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, {
      transport: 'stream',
      method: 'GET',
    });
    expect(check.refused).toBeNull();
  });

  it('defaults an operation with no explicit kind to `query`', () => {
    const runtime = createRuntime({ operation: {} as { operation: string } });
    const check = checkOperation(runtime, {} as GraphqlDocumentNodeLike, { transport: 'http' });
    expect(check.refused).toBeNull();
    expect(check.refused === null ? check.operation : null).toBe('query');
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

describe('toInternalError', () => {
  it('preserves the message and keeps originalError so masking applies', () => {
    const cause = new Error('connection string leaked');
    const err = toInternalError(cause);
    expect(err.message).toBe('connection string leaked');
    // `originalError` is the whole point: it is what makes `isExposable`
    // report false, so a throw escaping execute/subscribe is masked rather
    // than reaching the client verbatim.
    expect(err.originalError).toBe(cause);
    expect(isExposable(err)).toBe(false);
  });

  it('wraps a non-Error throw', () => {
    const err = toInternalError('string-thrown');
    expect(err.message).toBe('string-thrown');
    expect(err.originalError).toBeInstanceOf(Error);
    expect(isExposable(err)).toBe(false);
  });

  it('falls back to a generic message for an empty-message Error', () => {
    const err = toInternalError(new Error(''));
    expect(err.message).toBe('Internal server error');
    expect(err.toJSON()).toEqual({ message: 'Internal server error' });
  });
});
