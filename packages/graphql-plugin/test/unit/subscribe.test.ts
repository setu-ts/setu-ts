/**
 * Tests for execution/subscribe.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { subscribeGraphql } from '../../src/execution/subscribe.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import { DocumentCache } from '../../src/execution/document-cache.ts';

const createFakeRuntime = (overrides?: Partial<GraphqlRuntime>): GraphqlRuntime =>
  ({
    parse: (_src: string) => ({
      kind: 'Document',
      definitions: [{
        kind: 'OperationDefinition',
        operation: 'query',
        selectionSet: { kind: 'SelectionSet', selections: [] },
      }],
    }),
    validate: () => [],
    execute: () => Promise.resolve({ data: { hello: 'world' } }),
    subscribe: () =>
      Promise.resolve((async function* () {
        yield { data: { counter: 1 } };
        yield { data: { counter: 2 } };
      })()),
    buildSchema: () => ({}),
    validateSchema: () => [],
    getOperationAST: (document: { definitions: unknown[] }) => document.definitions[0] ?? null,
    GraphQLError: class extends Error {
      override name = 'GraphQLError';
      toJSON() {
        return { message: this.message };
      }
    },
    NoSchemaIntrospectionCustomRule: {},
    specifiedRules: [],
    ...overrides,
  }) as GraphqlRuntime;

const createFakeSchema = (): GraphqlSchemaLike =>
  ({
    getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
    getMutationType: () => null,
    getSubscriptionType: () => ({
      name: 'Subscription',
      getFields: () => ({}),
      getInterfaces: () => [],
    }),
    getType: () => null,
    getPossibleTypes: () => [],
    getDirectives: () => [],
    getDirective: () => null,
    toAST: () => ({}),
  }) as GraphqlSchemaLike;

describe('subscribeGraphql', () => {
  it('returns kind:single for a query operation', async () => {
    const runtime = createFakeRuntime();
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('{ hello }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(outcome.kind).toBe('single');
    if (outcome.kind === 'single') {
      expect(outcome.result.data).toEqual({ hello: 'world' });
    }
  });

  it('returns kind:stream for a subscription operation', async () => {
    const runtime = createFakeRuntime({
      parse: (_src: string) => ({
        kind: 'Document',
        definitions: [{
          kind: 'OperationDefinition',
          operation: 'subscription',
          selectionSet: { kind: 'SelectionSet', selections: [] },
        }],
      }),
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('subscription { counter }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(outcome.kind).toBe('stream');
    if (outcome.kind === 'stream') {
      const results = [];
      for await (const r of outcome.stream) {
        results.push(r);
      }
      expect(results.length).toBe(2);
    }
  });

  it('returns kind:error for parse failure', async () => {
    const runtime = createFakeRuntime({
      parse: () => {
        throw new Error('Syntax Error');
      },
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('{ invalid', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.result.errors).not.toBeNull();
      expect(outcome.result.errors![0].message).toBe('Syntax Error');
      expect(outcome.status).toBe(400);
    }
  });

  it('returns kind:error for validation errors', async () => {
    const runtime = createFakeRuntime({
      validate: () => [{ message: 'Unknown field', toJSON: () => ({ message: 'Unknown field' }) }],
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('{ hello }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.result.errors).not.toBeNull();
      expect(outcome.result.errors![0].message).toBe('Unknown field');
    }
  });

  it('reuses cached document on repeated calls', async () => {
    let parseCallCount = 0;
    const runtime = createFakeRuntime({
      parse: (_src: string) => {
        parseCallCount++;
        return {
          kind: 'Document',
          definitions: [{
            kind: 'OperationDefinition',
            operation: 'query',
            selectionSet: { kind: 'SelectionSet', selections: [] },
          }],
        };
      },
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    await subscribeGraphql('{ hello }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });
    await subscribeGraphql('{ hello }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(parseCallCount).toBe(1);
  });

  it('resolves operation by name', async () => {
    const runtime = createFakeRuntime({
      getOperationAST: (_doc: unknown, name?: string) => ({
        kind: 'OperationDefinition',
        operation: name === 'MyQuery' ? 'mutation' : 'query',
      }),
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('mutation MyQuery { set { id } }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
      operationName: 'MyQuery',
    });

    // Mutation is dispatched as single result
    expect(outcome.kind).toBe('single');
  });

  it('returns kind:error when operation cannot be resolved', async () => {
    const runtime = createFakeRuntime({
      getOperationAST: () => null,
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('{ hello }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.result.errors![0].message).toContain('Could not resolve');
    }
  });

  // C2 regression: non-iterable subscribe result is delivered as error, not thrown.
  it('returns kind:error when subscribe returns a non-iterable result (C2)', async () => {
    const runtime = createFakeRuntime({
      parse: (_src: string) => ({
        kind: 'Document',
        definitions: [{
          kind: 'OperationDefinition',
          operation: 'subscription',
          selectionSet: { kind: 'SelectionSet', selections: [] },
        }],
      }),
      subscribe: () =>
        Promise.resolve({
          errors: [{ message: 'setup failed', toJSON: () => ({ message: 'setup failed' }) }],
        }),
    });
    const schema = createFakeSchema();
    const cache = new DocumentCache(100);

    const outcome = await subscribeGraphql('subscription { tick }', {
      schema,
      runtime,
      documentCache: cache,
      validationRules: [],
    });

    // C2: the non-iterable result is delivered as kind:'error', not thrown.
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.result.errors).toBeDefined();
      expect(outcome.result.errors![0].message).toBe('setup failed');
    }
  });
});

describe('subscribeGraphql — a throw from graphql is contained', () => {
  const subscriptionDoc = {
    kind: 'Document',
    definitions: [{
      kind: 'OperationDefinition',
      operation: 'subscription',
      selectionSet: { kind: 'SelectionSet', selections: [] },
    }],
  };

  it('turns a throwing `subscribe` into a maskable error outcome, not a rejection', async () => {
    // graphql throws exactly this when a subscription field has no event
    // source — the failure that made the SSE route answer the kernel's 500.
    const runtime = createFakeRuntime({
      parse: () => subscriptionDoc,
      subscribe: () => {
        throw new Error('Subscription field must return Async Iterable. Received: undefined.');
      },
    } as Partial<GraphqlRuntime>);

    const outcome = await subscribeGraphql('subscription { tick }', {
      schema: createFakeSchema(),
      runtime,
      documentCache: new DocumentCache(10),
      validationRules: [],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.status).toBe(500);
    // `originalError` is carried, so the service's masking step catches it.
    const first = outcome.result.errors?.[0] as { originalError?: Error } | undefined;
    expect(first?.originalError).toBeInstanceOf(Error);
  });

  it('turns a throwing `execute` into a maskable error outcome', async () => {
    const runtime = createFakeRuntime({
      execute: () => {
        throw new Error('resolver blew up at setup');
      },
    } as Partial<GraphqlRuntime>);

    const outcome = await subscribeGraphql('{ hello }', {
      schema: createFakeSchema(),
      runtime,
      documentCache: new DocumentCache(10),
      validationRules: [],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.status).toBe(500);
  });
});
