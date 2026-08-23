/**
 * Subscription execution — shared prologue, three-arm outcome.
 *
 * @module
 * @since 0.3.0
 */

import type { GraphqlExecutionResult, GraphqlSubscriptionOutcome } from '@setu-ts/common';
import type {
  GraphqlDocumentNodeLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { DocumentCache } from './document-cache.ts';
import { prepareDocument, toInternalError } from './executor.ts';

/**
 * The single facade-to-contract adaptation point for this module.
 *
 * The plugin reads execution results through the structural graphql facades
 * (`GraphqlExecutionResultLike`, M70i X6-3) so the real `graphql` package
 * assigns without a cast, but the transports serialize the committed
 * `GraphqlExecutionResult` contract from `@setu-ts/common`. The two shapes
 * agree field-for-field at runtime — both are plain `{ data, errors }` — yet
 * TypeScript cannot prove it: the facade widens `errors` to a
 * `ReadonlyArray<GraphqlGraphQLErrorLike>` while the contract names
 * `GraphqlFormattedError[]`. Every conversion in this module funnels through
 * this one named function so that justification lives here instead of in
 * scattered double casts.
 */
function fromFacade<T>(value: unknown): T {
  return value as T;
}

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
 * Accepts query, mutation, and subscription documents and dispatches on the
 * operation kind the shared prologue already resolved — the transports never
 * re-parse a document to decide which path to take.
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
  const { runtime, schema } = options;

  const prepared = prepareDocument(query, { ...options, transport: 'stream' });
  if (!prepared.ok) {
    return {
      kind: 'error',
      status: prepared.outcome.status,
      result: fromFacade<GraphqlExecutionResult>(prepared.outcome.result),
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
    document: prepared.document,
    rootValue: options.rootValue,
    contextValue: options.contextValue,
    variableValues: options.variableValues ?? {},
  };
  if (options.operationName && options.operationName.length > 0) {
    execArgs.operationName = options.operationName;
  }

  // A throw from graphql (a schema whose subscription field has no event
  // source, a resolver that throws during setup) must become an outcome the
  // transport can put on the wire as a protocol error. Letting it reject would
  // surface as the kernel's 500 on the SSE route and as an unhandled rejection
  // on the socket — neither of which a graphql client can interpret.
  try {
    if (prepared.operation === 'subscription') {
      const result = await runtime.subscribe(execArgs);
      // graphql 16 returns a single `{errors}` result — not an iterable — when
      // the event stream cannot be created at all.
      const maybeIterable = result as { [Symbol.asyncIterator]?: unknown };
      if (typeof maybeIterable[Symbol.asyncIterator] !== 'function') {
        return {
          kind: 'error',
          status: 200,
          result: fromFacade<GraphqlExecutionResult>(result),
        };
      }
      return {
        kind: 'stream',
        status: 200,
        stream: fromFacade<AsyncIterable<GraphqlExecutionResult>>(result),
      };
    }

    const result = await runtime.execute(execArgs);
    return { kind: 'single', status: 200, result: fromFacade<GraphqlExecutionResult>(result) };
  } catch (e) {
    return {
      kind: 'error',
      status: 500,
      result: fromFacade<GraphqlExecutionResult>({ errors: [toInternalError(e)] }),
    };
  }
}
