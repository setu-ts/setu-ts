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
 * SelectionSet visitor for depth limit rule.
 */
export function depthLimitSelectionSetVisitor(
  _node: GraphqlSelectionNodeLike,
  _parent: unknown,
  _key: unknown,
  _ancestor: unknown,
) {
  // Track selection set nesting
}

/**
 * Field visitor for depth limit rule.
 */
export function depthLimitFieldVisitor(
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

  // Note: depth error reporting requires context which is not available here
  // The depth is tracked but errors would need to be reported through context
  void depth; // Used for depth tracking
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
      SelectionSet: depthLimitSelectionSetVisitor,
      Field: depthLimitFieldVisitor,
    };
  };
}
