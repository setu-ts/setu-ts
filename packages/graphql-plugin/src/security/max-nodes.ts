/**
 * Query breadth limiting validation rule.
 *
 * Depth and breadth are different dimensions, and `maxDepth` bounds only the
 * first. A document can be two levels deep and still ask for a hundred
 * thousand fields, because every alias is a separate field:
 *
 * ```graphql
 * query { a0: user { id } a1: user { id } ... a99999: user { id } }
 * ```
 *
 * That document has depth 2, so a `maxDepth: 5` limiter sees nothing wrong
 * with it, and the only thing standing between it and the process is the
 * request-body limit. This rule bounds the number of fields an operation would
 * resolve instead, which is a proxy for the WORK rather than for the shape.
 *
 * @module
 */

import type {
  GraphqlDefinitionNodeLike,
  GraphqlDocumentNodeLike,
  GraphqlGraphQLErrorLike,
  GraphqlSelectionNodeLike,
} from '../interfaces/graphql-runtime.ts';

/**
 * Validation rule context interface (subset of GraphQL's ValidationContext).
 */
interface ValidationRuleContext {
  reportError(error: GraphqlGraphQLErrorLike): void;
}

/**
 * The visitor a validation rule hands back to `validate`.
 *
 * `Document` is optional because a disabled rule (`maxNodes <= 0`) returns an
 * empty visitor, which contributes nothing to the traversal.
 */
interface MaxNodesVisitor {
  Document?(node: GraphqlDocumentNodeLike): void;
}

/** A selection set, in the shape both definition and selection nodes carry. */
type SelectionSetLike = { selections: readonly GraphqlSelectionNodeLike[] } | null | undefined;

/**
 * Counts the fields an operation would resolve, expanding fragment spreads.
 *
 * Three properties are deliberate:
 *
 * - **A fragment spread costs its definition's fields, at every spread site.**
 *   Counting a fragment once per DEFINITION would leave the obvious evasion
 *   open — define a hundred fields once, spread it a thousand times, and a
 *   document of eleven hundred nodes drives a hundred thousand resolutions.
 * - **Expansion is memoized**, so a document nesting fragments can report a
 *   very large count in time linear in the document's own size. Without it the
 *   counter itself would be the denial of service.
 * - **A fragment re-entered while it is being expanded counts as zero.** A
 *   cycle is already rejected by graphql's own `NoFragmentCycles` rule, which
 *   runs in the same pass; the guard exists so this rule terminates on a
 *   document that has not reached that rule's report yet.
 *
 * An unresolvable spread also counts zero — `KnownFragmentNames` reports it.
 *
 * @param document - The parsed document
 * @returns The number of fields the document's operations would resolve
 */
export function countResolvedFields(document: GraphqlDocumentNodeLike): number {
  const fragments = new Map<string, GraphqlDefinitionNodeLike>();
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition' && definition.name) {
      fragments.set(definition.name.value, definition);
    }
  }

  const memo = new Map<string, number>();
  const expanding = new Set<string>();

  const countSelections = (selectionSet: SelectionSetLike): number => {
    if (!selectionSet) return 0;
    let total = 0;
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'FragmentSpread') {
        total += countFragment(selection.name?.value);
      } else if (selection.kind === 'InlineFragment') {
        // An inline fragment is not itself a resolved field — only what it
        // selects is.
        total += countSelections(selection.selectionSet);
      } else {
        // A Field. Its alias does not matter here: two aliases of one field
        // are two separate `Field` nodes, which is precisely the breadth this
        // rule exists to bound.
        total += 1 + countSelections(selection.selectionSet);
      }
    }
    return total;
  };

  const countFragment = (name: string | undefined): number => {
    if (name === undefined) return 0;
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (expanding.has(name)) return 0;
    const definition = fragments.get(name);
    if (definition === undefined) return 0;
    expanding.add(name);
    const total = countSelections(definition.selectionSet);
    expanding.delete(name);
    memo.set(name, total);
    return total;
  };

  let total = 0;
  for (const definition of document.definitions) {
    if (definition.kind === 'OperationDefinition') {
      total += countSelections(definition.selectionSet);
    }
  }
  return total;
}

/**
 * Creates a validation rule that limits the number of fields a document
 * resolves.
 *
 * The return type is written out rather than inferred: this function is part of
 * the package's public API, and JSR rejects an inferred return type there
 * ("slow types") because it blocks automatic `.d.ts` generation for Node.
 *
 * @param maxNodes - Maximum resolved fields (0 or below disables the rule)
 * @param GraphQLError - The GraphQLError constructor used to report a refusal
 * @returns A validation rule function (receives context, returns visitor)
 */
export function createMaxNodesRule(
  maxNodes: number,
  GraphQLError: new (message: string) => GraphqlGraphQLErrorLike,
): (context: ValidationRuleContext) => MaxNodesVisitor {
  if (maxNodes <= 0) {
    // A no-op rule that contributes nothing to the traversal.
    return (_context: ValidationRuleContext) => ({});
  }

  return (context: ValidationRuleContext) => ({
    // Counted once, at the document root, rather than per `Field` visit: the
    // count needs fragment expansion, which a per-field visitor cannot do
    // without re-walking the document for every field it sees.
    Document(node: GraphqlDocumentNodeLike): void {
      const count = countResolvedFields(node);
      if (count > maxNodes) {
        context.reportError(
          new GraphQLError(
            `Query is too large. Maximum node count is ${maxNodes}, ` +
              `but query resolves ${count} fields`,
          ),
        );
      }
    },
  });
}
