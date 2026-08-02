/**
 * GraphQL executor — parse, validate, and execute.
 *
 * @module
 */

import type {
  GraphqlDocumentNodeLike,
  GraphqlExecutionResultLike,
  GraphqlGraphQLErrorLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { DocumentCache } from './document-cache.ts';

/**
 * Execution options for the executor.
 */
export interface ExecuteOptions {
  schema: GraphqlSchemaLike;
  runtime: GraphqlRuntime;
  documentCache: DocumentCache;
  validationRules: unknown[];
  maxDepth: number;
  introspection: boolean;
}

/**
 * Parse a query string into a document.
 */
function parseDocument(runtime: GraphqlRuntime, query: string): GraphqlDocumentNodeLike {
  return runtime.parse(query);
}

/**
 * Validate a document against a schema.
 */
function validateDocument(
  runtime: GraphqlRuntime,
  schema: GraphqlSchemaLike,
  document: GraphqlDocumentNodeLike,
  rules: unknown[],
): GraphqlGraphQLErrorLike[] {
  return runtime.validate(schema, document, rules);
}

/**
 * Execute a document.
 */
function executeDocument(
  runtime: GraphqlRuntime,
  schema: GraphqlSchemaLike,
  document: GraphqlDocumentNodeLike,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Record<string, unknown>,
  operationName?: string,
): Promise<GraphqlExecutionResultLike> {
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
    rootValue,
    contextValue,
    variableValues: variableValues ?? {},
  };
  if (operationName && operationName.length > 0) {
    execArgs.operationName = operationName;
  }
  return runtime.execute(execArgs);
}

/**
 * Execute a GraphQL query.
 */
export function executeGraphql(
  query: string,
  options: ExecuteOptions & {
    operationName?: string;
    variableValues?: Record<string, unknown>;
    rootValue?: unknown;
    contextValue?: unknown;
  },
): Promise<GraphqlExecutionResultLike> {
  const { runtime, schema, documentCache, validationRules } = options;

  // Parse (with cache)
  const cached = documentCache.get(query);
  let document: GraphqlDocumentNodeLike;
  let validationErrors: GraphqlGraphQLErrorLike[] | null;

  if (cached) {
    document = cached.document;
    validationErrors = cached.validationErrors;
  } else {
    // B3: Wrap parse in try/catch to return 400 with locations
    try {
      document = parseDocument(runtime, query);
      validationErrors = null;
    } catch (e) {
      // Parse error - return as GraphQLError-like with locations
      const parseError = e as Error & { locations?: Array<{ line: number; column: number }> };
      const errorObj = {
        message: parseError.message || 'Parse error',
        locations: parseError.locations,
        toJSON() {
          return {
            message: parseError.message || 'Parse error',
            locations: parseError.locations,
          };
        },
      };
      return Promise.resolve({ errors: [errorObj as unknown as GraphqlGraphQLErrorLike] });
    }
  }

  // Build validation rules - validationRules from caller already includes depth limit and introspection rules
  const rules: unknown[] = [...validationRules];

  // Validate (if not cached)
  if (!cached) {
    validationErrors = validateDocument(runtime, schema, document, rules);
    documentCache.set(query, { document, validationErrors });
  }

  if (validationErrors && validationErrors.length > 0) {
    // Return execution result with errors
    const result: GraphqlExecutionResultLike = { errors: validationErrors };
    return Promise.resolve(result);
  }

  // Execute
  return executeDocument(
    runtime,
    schema,
    document,
    options.rootValue,
    options.contextValue,
    options.variableValues,
    options.operationName,
  );
}
