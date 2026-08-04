/**
 * Subscription execution — shared prologue, three-arm outcome.
 *
 * @module
 * @since 0.3.0
 */

import type { GraphqlExecutionResult, GraphqlSubscriptionOutcome } from '@hono-enterprise/common';
import type {
  GraphqlDocumentNodeLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { DocumentCache } from './document-cache.ts';
import { codedError, toParseError } from './executor.ts';

/**
 * Options shared between the executor and subscribe pipeline.
 */
export interface SubscribeOptions {
  schema: GraphqlSchemaLike;
  runtime: GraphqlRuntime;
  documentCache: DocumentCache;
  validationRules: unknown[];
  rootValue?: unknown;
  contextValue?: unknown;
}

/**
 * Subscribe to a GraphQL operation.
 *
 * Accepts query, mutation, and subscription documents. Returns the matching
 * discriminated outcome the transports narrow on.
 *
 * @param query - The raw query string
 * @param options - The subscription options
 * @returns The three-arm outcome
 */
export async function subscribeGraphql(
  query: string,
  options: SubscribeOptions & {
    operationName?: string;
    variableValues?: Record<string, unknown>;
  },
): Promise<GraphqlSubscriptionOutcome> {
  const { runtime, schema, documentCache, validationRules } = options;

  // Parse
  const cached = documentCache.get(query);
  let document: GraphqlDocumentNodeLike;
  let validationErrors: import('../interfaces/graphql-runtime.ts').GraphqlGraphQLErrorLike[] | null;

  if (cached) {
    document = cached.document;
    validationErrors = cached.validationErrors;
  } else {
    try {
      document = runtime.parse(query);
    } catch (e) {
      return {
        kind: 'error',
        status: 400,
        result: { errors: [toParseError(e)] },
      };
    }
    validationErrors = null;
  }

  // Resolve operation
  const name = options.operationName && options.operationName.length > 0
    ? options.operationName
    : undefined;
  const ast = runtime.getOperationAST(document, name);
  if (!ast) {
    return {
      kind: 'error',
      status: 400,
      result: {
        errors: [
          codedError(
            'Could not resolve which operation to execute. Provide `operationName`.',
            'OPERATION_RESOLUTION_FAILED',
          ),
        ],
      },
    };
  }

  // Validate (use cached or compute)
  if (!cached) {
    validationErrors = runtime.validate(schema, document, validationRules);
    documentCache.set(query, { document, validationErrors });
  }

  if (validationErrors && validationErrors.length > 0) {
    return {
      kind: 'error',
      status: 400,
      result: { errors: validationErrors as never },
    };
  }

  const execArgs: {
    schema: GraphqlSchemaLike;
    document: GraphqlDocumentNodeLike;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: Record<string, unknown>;
    operationName?: string;
  } = {
    schema,
    document,
    rootValue: options.rootValue,
    contextValue: options.contextValue,
    variableValues: options.variableValues ?? {},
  };
  if (options.operationName && options.operationName.length > 0) {
    execArgs.operationName = options.operationName;
  }

  // Dispatch: subscription → stream; query/mutation → execute
  if (ast.operation === 'subscription') {
    const result = await runtime.subscribe(execArgs);
    // C2: graphql 16 may return a single {errors:[…]} when the event stream
    // cannot be created (resolver throws at setup, returns a non-iterable, etc).
    // Detect whether the result is actually async-iterable; if not, deliver it
    // as a single error result rather than casting/throwing.
    const maybeIterable = result as { [Symbol.asyncIterator]?: unknown };
    if (typeof maybeIterable[Symbol.asyncIterator] !== 'function') {
      return {
        kind: 'error',
        status: 200,
        result: result as GraphqlExecutionResult,
      };
    }
    return {
      kind: 'stream',
      status: 200,
      stream: result as AsyncIterable<GraphqlExecutionResult>,
    };
  }

  const result = await runtime.execute(execArgs);
  return {
    kind: 'single',
    status: 200,
    result: result as GraphqlExecutionResult,
  };
}
