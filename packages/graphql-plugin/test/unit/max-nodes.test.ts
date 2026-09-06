/**
 * Tests for max-nodes.ts (M90a §3.6).
 *
 * X32-6: `maxDepth` was the only query-cost control, and it bounds NESTING.
 * The measured attack was 100,000 aliases at depth 2 — a document `maxDepth: 5`
 * has no objection to — producing a ~5 MB response and **+822 MB RSS** from one
 * request.
 *
 * Every fixture here is a REAL parsed document from `npm:graphql`, never a
 * hand-built `{ kind: 'SelectionSet' }` object: six tests in
 * `depth-limit.test.ts` once fed the depth rule fixtures it could never match,
 * so they measured depth 0 and documented a fiction (M51b).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { countResolvedFields, createMaxNodesRule } from '../../src/security/max-nodes.ts';
import type {
  GraphqlDocumentNodeLike,
  GraphqlGraphQLErrorLike,
} from '../../src/interfaces/graphql-runtime.ts';

/**
 * A double for `GraphQLError`, honouring the whole facade rather than the one
 * member this rule happens to read — a fixture that omits `toJSON` would stop
 * standing in for the real class the moment the rule reported through it.
 */
class MockGraphQLError extends Error implements GraphqlGraphQLErrorLike {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
  toJSON(): { message: string } {
    return { message: this.message };
  }
}

// The real parser. The rule reads only `kind`, `name` and `selectionSet`, all
// of which are structural, so a real `DocumentNode` is assignable to the facade.
const { parse } = await import('npm:graphql@^16');

function doc(source: string): GraphqlDocumentNodeLike {
  return parse(source) as unknown as GraphqlDocumentNodeLike;
}

/** Drives the rule over one document and collects what it reported. */
function run(maxNodes: number, source: string): string[] {
  const reported: string[] = [];
  const rule = createMaxNodesRule(maxNodes, MockGraphQLError);
  const visitor = rule({ reportError: (e) => reported.push(e.message) });
  visitor.Document?.(doc(source));
  return reported;
}

describe('countResolvedFields', () => {
  it('counts one field', () => {
    expect(countResolvedFields(doc('{ a }'))).toBe(1);
  });

  it('counts a parent AND its children', () => {
    // `user` is itself resolved, then `id` and `name`.
    expect(countResolvedFields(doc('{ user { id name } }'))).toBe(3);
  });

  it('counts every ALIAS separately — the dimension depth cannot see', () => {
    // The X32-6 shape in miniature: depth 2, breadth 3.
    expect(countResolvedFields(doc('{ a: user { id } b: user { id } c: user { id } }'))).toBe(6);
  });

  it('a deep-but-narrow query counts few fields', () => {
    // Depth 5, one field per level: `maxDepth` refuses this and `maxNodes`
    // should not. The two bound different things.
    expect(countResolvedFields(doc('{ a { b { c { d { e } } } } }'))).toBe(5);
  });

  it('reports the LARGEST operation, not the sum of all of them', () => {
    // Only one operation is ever executed — the one `operationName` selects — so
    // summing refuses a bundled document whose selected operation is well within
    // budget. Before this the same document counted 3.
    expect(countResolvedFields(doc('query A { a b } query B { c }'))).toBe(2);
    expect(countResolvedFields(doc('query A { a } query B { b c d }'))).toBe(3);
  });

  it('a single-operation document is unaffected by the maximum', () => {
    // The overwhelmingly common shape: max over one operation IS that operation.
    expect(countResolvedFields(doc('{ user { id name } }'))).toBe(3);
  });

  it('an inline fragment costs only what it selects', () => {
    // The fragment is not itself a resolved field.
    expect(countResolvedFields(doc('{ node { ... on User { id name } } }'))).toBe(3);
  });

  it('a fragment spread costs its definition at EVERY spread site', () => {
    // The evasion a per-definition count would leave open: define the fields
    // once, spread them many times.
    const source = `
      query { a { ...F } b { ...F } c { ...F } }
      fragment F on Thing { one two three }
    `;
    // 3 parents + 3 spreads x 3 fields = 12.
    expect(countResolvedFields(doc(source))).toBe(12);
  });

  it('nested fragments multiply, and the count stays computable', () => {
    // Without memoization the COUNTER would itself be the denial of service.
    // Ten levels of doubling is 1024 leaves; the walk is linear in the
    // document's own size.
    const levels = Array.from(
      { length: 10 },
      (_, i) => `fragment F${i} on T { x: n { ...F${i + 1} } y: n { ...F${i + 1} } }`,
    ).join('\n');
    const source = `query { root { ...F0 } }\n${levels}\nfragment F10 on T { leaf }`;
    // 1 root + the expanded tree. Only the magnitude matters: it must be large
    // and it must be reached without hanging.
    expect(countResolvedFields(doc(source))).toBeGreaterThan(1000);
  });

  it('an unresolvable fragment spread counts zero', () => {
    // `KnownFragmentNames`, which runs in the same validation pass, reports it.
    expect(countResolvedFields(doc('{ a { ...Missing } }'))).toBe(1);
  });

  it('a fragment cycle terminates rather than recursing forever', () => {
    // `NoFragmentCycles` reports the real error; this rule only has to finish.
    const source = `
      query { a { ...F } }
      fragment F on T { one ...G }
      fragment G on T { two ...F }
    `;
    expect(countResolvedFields(doc(source))).toBeGreaterThan(0);
  });

  it('a spread carrying no name counts zero', () => {
    // The ONE fixture here that is hand-built rather than parsed, and
    // deliberately so: `GraphqlSelectionNodeLike.name` is optional because
    // graphql@16's own `SelectionNode` union has members without one, so this
    // asserts the FACADE's boundary rather than the rule's semantics. A real
    // parsed `FragmentSpread` always carries a name, which is why the parser
    // cannot produce this input.
    const handBuilt: GraphqlDocumentNodeLike = {
      kind: 'Document',
      definitions: [{
        kind: 'OperationDefinition',
        selectionSet: { selections: [{ kind: 'FragmentSpread' }] },
      }],
    };
    expect(countResolvedFields(handBuilt)).toBe(0);
  });

  it('a document with no operation counts zero', () => {
    expect(countResolvedFields(doc('fragment F on T { a b }'))).toBe(0);
  });

  it('a mutation and a subscription are counted like a query', () => {
    expect(countResolvedFields(doc('mutation { create { id } }'))).toBe(2);
    expect(countResolvedFields(doc('subscription { events { id } }'))).toBe(2);
  });
});

describe('createMaxNodesRule', () => {
  it('reports nothing when the document is within budget', () => {
    expect(run(10, '{ a b c }')).toEqual([]);
  });

  it('accepts a document EXACTLY at the budget', () => {
    expect(run(3, '{ a b c }')).toEqual([]);
  });

  it('refuses a document one field past the budget', () => {
    const reported = run(3, '{ a b c d }');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('Maximum node count is 3');
    expect(reported[0]).toContain('its largest operation resolves 4 fields');
  });

  it('refuses an alias bomb at depth 2', () => {
    // The finding: a document `maxDepth` cannot object to.
    const aliases = Array.from({ length: 200 }, (_, i) => `a${i}: user { id }`).join(' ');
    const reported = run(50, `{ ${aliases} }`);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('its largest operation resolves 400 fields');
  });

  it('accepts the SAME alias bomb when maxNodes is unset', () => {
    // The discriminating half — default-off, so no released application starts
    // refusing a document it used to serve.
    const aliases = Array.from({ length: 200 }, (_, i) => `a${i}: user { id }`).join(' ');
    expect(run(0, `{ ${aliases} }`)).toEqual([]);
  });

  it('leaves a deep-but-narrow query alone', () => {
    // Proves the two limiters are independent: this document is depth 5 and
    // would be refused by `maxDepth: 2`, and `maxNodes: 10` has no view on it.
    expect(run(10, '{ a { b { c { d { e } } } } }')).toEqual([]);
  });

  it('reports at most ONE error per document', () => {
    // The count is taken once, at the document root, rather than per field.
    const reported = run(1, '{ a b c d e }');
    expect(reported).toHaveLength(1);
  });

  it('a budget of 0 disables the rule and returns an EMPTY visitor', () => {
    const rule = createMaxNodesRule(0, MockGraphQLError);
    const visitor = rule({ reportError: () => {} });
    expect(visitor.Document).toBeUndefined();
  });

  it('a negative budget disables the rule too', () => {
    const rule = createMaxNodesRule(-1, MockGraphQLError);
    expect(rule({ reportError: () => {} }).Document).toBeUndefined();
  });

  it('a NaN budget makes the rule silently INERT — which is why the service refuses it', () => {
    // `maxNodes <= 0` is `false` for NaN, so the rule IS created; then
    // `count > NaN` is `false` for every document, so it never reports. The
    // limit reads as configured and enforces nothing — fail-open. `GraphqlService`
    // refuses the value at construction so this state is unreachable through
    // either documented entry point; see `graphql-service.test.ts`.
    const reported: string[] = [];
    const rule = createMaxNodesRule(Number.NaN, MockGraphQLError);
    const visitor = rule({ reportError: (e) => reported.push(e.message) });
    expect(visitor.Document).toBeDefined();
    visitor.Document?.(doc('{ a b c d e f g h }'));
    expect(reported).toEqual([]);
  });
});
