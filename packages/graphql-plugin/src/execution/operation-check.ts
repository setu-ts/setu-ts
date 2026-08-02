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
 * Get operation kind from query string by simple text search.
 * This is a lightweight alternative that doesn't require parsing.
 *
 * @param query - The query string
 * @returns The operation kind or undefined
 */
export function getOperationKindFromQuery(query: string): OperationKind | undefined {
  const trimmed = query.trim();
  if (trimmed.startsWith('mutation') || trimmed.startsWith('mutation ')) {
    return 'mutation';
  }
  if (trimmed.startsWith('subscription') || trimmed.startsWith('subscription ')) {
    return 'subscription';
  }
  if (trimmed.startsWith('query') || trimmed.startsWith('query ') || trimmed.startsWith('{')) {
    return 'query';
  }
  return undefined;
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
