/**
 * Tests for depth-limit.ts
 *
 * The rule measures depth from the **visitor path keys** `graphql` supplies as
 * `ancestors` — an array like
 * `['definitions', 0, 'selectionSet', 'selections', 0, 'selectionSet', ...]`, in
 * which each literal `'selectionSet'` string is one nesting level. Feeding it
 * AST-shaped objects such as `{ kind: 'SelectionSet' }` measures nothing: the
 * depth is always 0 and the rule can never report. The fixtures below therefore
 * use the real path-key shape, and `graphql-security-e2e.test.ts` exercises the
 * rule against the real validator.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDepthLimitRule } from '../../src/security/depth-limit.ts';

interface MockGraphQLErrorLike {
  message: string;
  toJSON(): { message: string };
}

class MockGraphQLError extends Error implements MockGraphQLErrorLike {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
  toJSON() {
    return { message: this.message };
  }
}

/** Build the ancestor path `graphql` passes for a field nested `depth` levels. */
function pathForDepth(depth: number): unknown[] {
  const ancestors: unknown[] = ['definitions', 0];
  for (let i = 0; i < depth; i++) {
    ancestors.push('selectionSet', 'selections', 0);
  }
  return ancestors;
}

/** Drive the rule over one field at `depth` and collect what it reported. */
function runAtDepth(maxDepth: number, depth: number): string[] {
  const reported: string[] = [];
  const rule = createDepthLimitRule(maxDepth, MockGraphQLError);
  const visitor = rule({ reportError: (e) => reported.push(e.message) }) as {
    Field?: (...args: unknown[]) => void;
  };
  visitor.Field?.({}, null, null, pathForDepth(depth));
  return reported;
}

describe('createDepthLimitRule', () => {
  it('returns a rule function exposing a Field visitor', () => {
    const rule = createDepthLimitRule(10, MockGraphQLError);
    expect(typeof rule).toBe('function');
    expect(rule({ reportError: () => {} })).toHaveProperty('Field');
  });

  it('reports nothing for a document at the limit', () => {
    expect(runAtDepth(5, 5)).toEqual([]);
  });

  it('reports nothing for a document below the limit', () => {
    expect(runAtDepth(5, 2)).toEqual([]);
  });

  it('reports once past the limit, naming both the limit and the depth reached', () => {
    const reported = runAtDepth(5, 6);

    expect(reported.length).toBe(1);
    expect(reported[0]).toBe(
      'Query is too deep. Maximum depth is 5, but query has depth of 6',
    );
  });

  it('reports only the first offending field, not one error per field', () => {
    const reported: string[] = [];
    const rule = createDepthLimitRule(2, MockGraphQLError);
    const visitor = rule({ reportError: (e) => reported.push(e.message) }) as {
      Field: (...args: unknown[]) => void;
    };

    // Three sibling fields, all too deep.
    visitor.Field({}, null, null, pathForDepth(4));
    visitor.Field({}, null, null, pathForDepth(5));
    visitor.Field({}, null, null, pathForDepth(6));

    expect(reported.length).toBe(1);
    expect(reported[0]).toContain('depth of 4');
  });

  it('disables the rule entirely at maxDepth 0', () => {
    const rule = createDepthLimitRule(0, MockGraphQLError);
    const visitor = rule({ reportError: () => {} });

    // No visitor at all — the rule contributes nothing to validation.
    expect(visitor).toEqual({});
    expect(runAtDepth(0, 50)).toEqual([]);
  });

  it('disables the rule at a negative maxDepth', () => {
    expect(createDepthLimitRule(-1, MockGraphQLError)({ reportError: () => {} })).toEqual({});
    expect(runAtDepth(-1, 50)).toEqual([]);
  });

  it('measures zero depth from an empty ancestor path', () => {
    const reported: string[] = [];
    const rule = createDepthLimitRule(1, MockGraphQLError);
    const visitor = rule({ reportError: (e) => reported.push(e.message) }) as {
      Field: (...args: unknown[]) => void;
    };

    visitor.Field({}, null, null, []);

    expect(reported).toEqual([]);
  });

  it('ignores path entries that are not the selectionSet key', () => {
    const reported: string[] = [];
    const rule = createDepthLimitRule(1, MockGraphQLError);
    const visitor = rule({ reportError: (e) => reported.push(e.message) }) as {
      Field: (...args: unknown[]) => void;
    };

    // Nulls, numbers, unrelated keys and AST-shaped objects all count for
    // nothing; only the literal 'selectionSet' key is a nesting level.
    visitor.Field({}, null, null, [
      null,
      undefined,
      0,
      'definitions',
      'selections',
      { kind: 'SelectionSet' },
      { foo: 'bar' },
    ]);

    expect(reported).toEqual([]);
  });
});
