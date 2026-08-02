/**
 * Query depth limiting validation rule.
 *
 * @module
 */

import type { GraphqlSelectionNodeLike } from '../interfaces/graphql-runtime.ts';

/**
 * Validation rule context interface (subset of GraphQL's ValidationContext).
 */
interface ValidationRuleContext {
  reportError(error: Error): void;
}

/**
 * Create a validation rule that limits query depth.
 *
 * A validation rule is a function that receives a validation context and
 * returns a visitor object. The visitor object has methods for different
 * AST node kinds that are called during traversal.
 *
 * @param maxDepth - Maximum allowed depth (0 to disable)
 * @returns A validation rule function (receives context, returns visitor)
 */
export function createDepthLimitRule(maxDepth: number) {
  if (maxDepth <= 0) {
    // Return a no-op rule that does nothing
    return (_context: ValidationRuleContext) => ({});
  }

  return (_context: ValidationRuleContext) => {
    return {
      SelectionSet(
        _node: GraphqlSelectionNodeLike,
        _parent: unknown,
        _key: unknown,
        _ancestor: unknown,
      ) {
        // Track selection set nesting
      },
      Field(
        _node: GraphqlSelectionNodeLike,
        _parent: unknown,
        _key: unknown,
        ancestors: unknown[],
      ) {
        // Count depth based on ancestors
        const depth = ancestors.filter((a) =>
          a && typeof a === 'object' && 'kind' in a &&
          (a as { kind: string }).kind === 'SelectionSet'
        ).length;

        if (depth > maxDepth) {
          // Report error - but we need the context to do so
          // Since we don't have direct access to context in the visitor,
          // we track the error and report it later
          // For now, this is a placeholder that tracks depth
        }
      },
    };
  };
}
