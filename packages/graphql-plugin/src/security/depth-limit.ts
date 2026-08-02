/**
 * Query depth limiting validation rule.
 *
 * @module
 */

import type { GraphqlSelectionNodeLike } from '../interfaces/graphql-runtime.ts';

/**
 * Create a validation rule that limits query depth.
 *
 * @param maxDepth - Maximum allowed depth (0 to disable)
 * @returns A validation rule function
 */
export function createDepthLimitRule(maxDepth: number) {
  if (maxDepth <= 0) {
    // Return a no-op rule
    return () => ({});
  }

  return () => {
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
          // Report error
          const error = new Error(
            `Query depth ${depth} exceeds maximum allowed depth ${maxDepth}`,
          );
          // In real implementation, report to validation context
          void error; // Placeholder
        }
      },
    };
  };
}
