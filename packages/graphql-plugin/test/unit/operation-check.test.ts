/**
 * Tests for operation-check.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { getOperationAST, hasSubscription } from '../../src/execution/operation-check.ts';
import type { GraphqlRuntime } from '../../src/interfaces/graphql-runtime.ts';

describe('operation-check', () => {
  const createFakeRuntime = (): GraphqlRuntime =>
    ({
      parse: (src: string) => {
        // Simple parser for basic queries
        if (src.includes('mutation')) {
          return {
            kind: 'Document',
            definitions: [
              {
                kind: 'OperationDefinition',
                operation: 'mutation',
                selectionSet: { kind: 'SelectionSet', selections: [] },
              },
            ],
          };
        }
        if (src.includes('subscription')) {
          return {
            kind: 'Document',
            definitions: [
              {
                kind: 'OperationDefinition',
                operation: 'subscription',
                selectionSet: { kind: 'SelectionSet', selections: [] },
              },
            ],
          };
        }
        return {
          kind: 'Document',
          definitions: [
            {
              kind: 'OperationDefinition',
              operation: 'query',
              selectionSet: { kind: 'SelectionSet', selections: [] },
            },
          ],
        };
      },
      validate: () => [],
      execute: () => Promise.resolve({ data: {} }),
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
      getOperationAST: (doc: { definitions: Array<{ operation: string }> }, _opName?: string) => {
        const def = doc.definitions[0];
        return def ? ({ operation: def.operation } as { operation: string }) : null;
      },
      GraphQLError: class extends Error {
        override name = 'GraphQLError';
        toJSON() {
          return { message: this.message };
        }
      },
      NoSchemaIntrospectionCustomRule: {},
      specifiedRules: [],
    }) as GraphqlRuntime;

  describe('getOperationAST', () => {
    it('returns query for simple query', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, '{ hello }');
      expect(kind).toBe('query');
    });

    it('returns mutation for mutation', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, 'mutation { setMessage }');
      expect(kind).toBe('mutation');
    });

    it('returns subscription for subscription', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, 'subscription { onMessage }');
      expect(kind).toBe('subscription');
    });

    it('returns undefined for invalid query', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, 'invalid query syntax');
      expect(kind).toBe('query');
    });

    it('returns undefined for empty string', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, '');
      expect(kind).toBe('query');
    });

    it('handles getOperationAST with operationName', () => {
      const runtime = createFakeRuntime();
      const kind = getOperationAST(runtime, 'query MyQuery { hello }', 'MyQuery');
      expect(kind).toBe('query');
    });

    it('handles parse errors gracefully', () => {
      const runtime = createFakeRuntime();
      (runtime as unknown as GraphqlRuntime).parse = () => {
        throw new Error('Parse error');
      };
      const kind = getOperationAST(runtime, 'invalid query');
      expect(kind).toBeUndefined();
    });

    it('handles getOperationAST returning null', () => {
      const runtime = createFakeRuntime();
      (runtime as unknown as GraphqlRuntime).getOperationAST = () => null;
      const kind = getOperationAST(runtime, '{ hello }');
      expect(kind).toBeUndefined();
    });
  });

  describe('hasSubscription', () => {
    it('returns true for subscription', () => {
      const runtime = createFakeRuntime();
      const result = hasSubscription(runtime, 'subscription { onMessage }');
      expect(result).toBe(true);
    });

    it('returns false for query', () => {
      const runtime = createFakeRuntime();
      const result = hasSubscription(runtime, '{ hello }');
      expect(result).toBe(false);
    });

    it('returns false for mutation', () => {
      const runtime = createFakeRuntime();
      const result = hasSubscription(runtime, 'mutation { x }');
      expect(result).toBe(false);
    });

    it('returns false for invalid query', () => {
      const runtime = createFakeRuntime();
      const result = hasSubscription(runtime, 'invalid');
      expect(result).toBe(false);
    });
  });

  describe('getOperationAST edge cases', () => {
    it('returns undefined when ast.operation is falsy', () => {
      const runtime = createFakeRuntime();
      (runtime as unknown as GraphqlRuntime).getOperationAST = () => ({ kind: 'OperationDefinition' } as never);
      const kind = getOperationAST(runtime, '{ hello }');
      expect(kind).toBeUndefined();
    });
  });
});
