/**
 * Query depth limiting validation rule.
 *
 * @module
 */

import type {
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
 * `Field` is optional because a disabled rule (`maxDepth <= 0`) returns an
 * empty visitor, which contributes nothing to the traversal.
 */
interface DepthLimitVisitor {
  Field?(
    node: GraphqlSelectionNodeLike,
    parent: unknown,
    key: unknown,
    ancestors: unknown[],
  ): void;
}

/**
 * Get depth from ancestor chain by counting SelectionSet path entries.
 * The ancestors array contains path keys like ["definitions", 0, "selectionSet", "selections", 0, ...]
 * Each "selectionSet" in the path indicates one level of nesting.
 */
function getDepth(ancestors: unknown[]): number {
  let depth = 0;
  for (const ancestor of ancestors) {
    // The ancestors array contains path keys, not AST nodes
    // Count occurrences of "selectionSet" which indicate nesting levels
    if (ancestor === 'selectionSet') {
      depth++;
    }
  }
  return depth;
}

/**
 * Create a validation rule that limits query depth.
 *
 * A validation rule is a function that receives a validation context and
 * returns a visitor object. The visitor object has methods for different
 * AST node kinds that are called during traversal.
 *
 * The return type is written out rather than inferred: this function is part of
 * the package's public API, and JSR rejects an inferred return type there
 * ("slow types") because it blocks automatic `.d.ts` generation for Node.
 *
 * @param maxDepth - Maximum allowed depth (0 to disable)
 * @param GraphQLError - The GraphQLError constructor to use for creating errors
 * @returns A validation rule function (receives context, returns visitor)
 */
export function createDepthLimitRule(
  maxDepth: number,
  GraphQLError: new (message: string) => GraphqlGraphQLErrorLike,
): (context: ValidationRuleContext) => DepthLimitVisitor {
  if (maxDepth <= 0) {
    // Return a no-op rule that does nothing
    return (_context: ValidationRuleContext) => ({});
  }

  return (context: ValidationRuleContext) => {
    let errorReported = false;

    return {
      Field(
        _node: GraphqlSelectionNodeLike,
        _parent: unknown,
        _key: unknown,
        ancestors: unknown[],
      ) {
        // Don't report multiple errors - just one is enough
        if (errorReported) {
          return;
        }

        const depth = getDepth(ancestors);

        if (depth > maxDepth) {
          const error = new GraphQLError(
            `Query is too deep. Maximum depth is ${maxDepth}, but query has depth of ${depth}`,
          );
          context.reportError(error);
          errorReported = true;
        }
      },
    };
  };
}
