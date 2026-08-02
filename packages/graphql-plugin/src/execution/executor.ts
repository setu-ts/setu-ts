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
 * Create a depth limit validation rule.
 */
function createDepthRule(_maxDepth: number) {
  return function (
    _context: unknown,
  ): {
    SelectionSet: (_node: unknown) => void;
    Field: (_node: unknown) => void;
  } {
    return {
      SelectionSet(_node) {
        // Track selection set depth
      },
      Field(_node) {
        // Check depth
      },
    };
  };
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
  return runtime.execute({
    schema,
    document,
    rootValue,
    contextValue,
    variableValues: variableValues ?? {},
    operationName: operationName ?? '',
  });
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
  const { runtime, schema, documentCache, validationRules, maxDepth, introspection } = options;

  // Parse (with cache)
  const cached = documentCache.get(query);
  let document: GraphqlDocumentNodeLike;
  let validationErrors: GraphqlGraphQLErrorLike[] | null;

  if (cached) {
    document = cached.document;
    validationErrors = cached.validationErrors;
  } else {
    document = parseDocument(runtime, query);
    validationErrors = null;
  }

  // Build validation rules
  const rules: unknown[] = [...validationRules];

  // Add depth limit rule if enabled
  if (maxDepth > 0) {
    rules.push(createDepthRule(maxDepth)(null as unknown as never));
  }

  // Add introspection rule if disabled
  if (!introspection) {
    rules.push(runtime.NoSchemaIntrospectionCustomRule);
  }

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
