/**
 * Operation kind checking — determine operation type from query.
 *
 * @module
 */

import type { GraphqlRuntime } from '../interfaces/graphql-runtime.ts';

/**
 * Operation kind.
 */
export type OperationKind = 'query' | 'mutation' | 'subscription';

/**
 * Get the operation kind from a query string.
 *
 * @param runtime - The graphql runtime
 * @param query - The query string
 * @param operationName - Optional operation name
 * @returns The operation kind or undefined
 */
export function getOperationAST(
  runtime: GraphqlRuntime,
  query: string,
  operationName?: string,
): OperationKind | undefined {
  try {
    const document = runtime.parse(query);
    const ast = runtime.getOperationAST(document, operationName);
    if (!ast) {
      return undefined;
    }
    return (ast.operation as OperationKind) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a query contains a subscription operation.
 *
 * @param runtime - The graphql runtime
 * @param query - The query string
 * @returns True if the query contains a subscription
 */
export function hasSubscription(runtime: GraphqlRuntime, query: string): boolean {
  const kind = getOperationAST(runtime, query);
  return kind === 'subscription';
}
