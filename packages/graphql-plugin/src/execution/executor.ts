/**
 * GraphQL executor — parse, operation-kind guard, validate, and execute.
 *
 * The pipeline is ordered so that the operation-kind guard runs **after** parse
 * and **before** validate, and so that a cached document is never re-parsed:
 * the guard reads the AST the cache already holds.
 *
 * @module
 */

import type {
  GraphqlDefinitionNodeLike,
  GraphqlDocumentNodeLike,
  GraphqlExecutionResultLike,
  GraphqlGraphQLErrorLike,
  GraphqlRuntime,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { DocumentCache } from './document-cache.ts';

/**
 * The outcome of one execution pass.
 *
 * `status` is the HTTP status implied under strict
 * (`application/graphql-response+json`) negotiation; `executed` records whether
 * the GraphQL operation actually ran, which is what separates a *request* error
 * (parse, validate, operation resolution) from a *field* error. A field error
 * that nulls `data` is still a `200` — the request itself succeeded.
 */
export interface ExecutionPhaseOutcome {
  /** HTTP status implied by the phase that produced this outcome. */
  status: number;
  /** True when the operation was handed to `execute`. */
  executed: boolean;
  /** The result to serialize. */
  result: GraphqlExecutionResultLike;
}

/**
 * Execution options for the executor.
 */
export interface ExecuteOptions {
  schema: GraphqlSchemaLike;
  runtime: GraphqlRuntime;
  documentCache: DocumentCache;
  /** The rule list assembled once at construction time. */
  validationRules: unknown[];
}

/**
 * Build a synthetic, client-facing error carrying a stable code.
 *
 * The shape matches what `mask-errors.ts` treats as exposable (a `message` and
 * no `originalError`), so these survive masking verbatim.
 */
export function codedError(message: string, code: string): GraphqlGraphQLErrorLike {
  return {
    message,
    extensions: { code },
    toJSON() {
      return { message, extensions: { code } };
    },
  };
}

/**
 * Normalize a thrown parse failure into an error the wire can carry.
 *
 * A real `graphql` syntax error is already a `GraphQLError` with `locations`
 * and no `originalError`, so it passes through untouched.
 */
export function toParseError(thrown: unknown): GraphqlGraphQLErrorLike {
  const err = thrown as Partial<GraphqlGraphQLErrorLike> & { message?: string };
  const message = typeof err?.message === 'string' && err.message.length > 0
    ? err.message
    : 'Parse error';
  const locations = err?.locations;
  return {
    message,
    ...(locations && { locations }),
    toJSON() {
      return { message, ...(locations && { locations }) };
    },
  };
}

/**
 * The result of {@linkcode prepareDocument} when the document is ready.
 */
export interface PreparedDocument {
  document: GraphqlDocumentNodeLike;
  validationErrors: GraphqlGraphQLErrorLike[] | null;
  operation: GraphqlDefinitionNodeLike;
}

/**
 * The result of {@linkcode prepareDocument} when the operation is refused.
 */
export interface PreparedRefusal {
  refused: true;
  status: number;
  result: GraphqlExecutionResultLike;
}

/**
 * Guard the resolved operation: refuse an unresolvable operation, a
 * subscription over HTTP, and a mutation over `GET`.
 *
 * Runs against an already-parsed document, so a cache hit costs no parse.
 *
 * @param runtime - The GraphQL runtime
 * @param document - The parsed document
 * @param options - Options controlling the transport arm
 * @returns An outcome to short-circuit with, or `null` to continue
 */
export function checkOperation(
  runtime: GraphqlRuntime,
  document: GraphqlDocumentNodeLike,
  options: {
    operationName?: string;
    method?: 'GET' | 'POST';
    transport: 'http' | 'stream';
  },
): ExecutionPhaseOutcome | PreparedRefusal | null {
  const name = options.operationName && options.operationName.length > 0
    ? options.operationName
    : undefined;
  const ast = runtime.getOperationAST(document, name);

  if (!ast) {
    return {
      refused: true,
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

  // HTTP transport: refuse subscriptions and mutations over GET
  if (options.transport === 'http') {
    if (ast.operation === 'subscription') {
      return {
        status: 400,
        executed: false,
        result: {
          errors: [
            codedError(
              'Subscriptions are not supported over HTTP',
              'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP',
            ),
          ],
        },
      };
    }

    if (ast.operation === 'mutation' && options.method === 'GET') {
      return {
        status: 405,
        executed: false,
        result: {
          errors: [codedError('Mutations are not allowed over GET', 'METHOD_NOT_ALLOWED')],
        },
      };
    }
  }

  return null;
}

/**
 * Shared parse → guard → validate prologue used by both the HTTP executor
 * and the subscription pipeline.
 *
 * Returns `null` when the query fails to parse (the caller must handle the
 * parse error separately since different transports need different error
 * carriers). Returns a refusal when the operation cannot be resolved.
 * Returns a {@linkcode PreparedDocument} on success.
 *
 * @param query - The raw query string
 * @param runtime - The GraphQL runtime
 * @param documentCache - The document cache
 * @param validationRules - The pre-built validation rule list
 * @param options - Operation options
 * @returns The prepared document, a refusal, or `null` on parse failure
 */
export function prepareDocument(
  query: string,
  runtime: GraphqlRuntime,
  documentCache: DocumentCache,
  validationRules: unknown[],
  options: {
    operationName?: string;
    transport: 'http' | 'stream';
  },
): PreparedDocument | PreparedRefusal | null {
  // Parse (cache hit reuses both the document and its validation result)
  const cached = documentCache.get(query);
  let document: GraphqlDocumentNodeLike;
  let validationErrors: GraphqlGraphQLErrorLike[] | null;

  if (cached) {
    document = cached.document;
    validationErrors = cached.validationErrors;
  } else {
    try {
      document = runtime.parse(query);
    } catch {
      return null; // parse failure — caller handles
    }
    validationErrors = null;
  }

  // Operation-kind guard: after parse, before validate
  const guard = checkOperation(runtime, document, {
    ...(options.operationName ? { operationName: options.operationName } : {}),
    transport: options.transport,
  });

  if (guard) {
    if ('refused' in guard) {
      return guard;
    }
    // HTTP transport refusal — convert to PreparedRefusal
    if (guard.executed === false) {
      return { refused: true, status: guard.status, result: guard.result };
    }
  }

  if (!cached) {
    validationErrors = runtime.validate(
      document as unknown as GraphqlSchemaLike,
      document,
      validationRules,
    );
    documentCache.set(query, { document, validationErrors });
  }

  // Resolve the operation AST for the caller
  const name = options.operationName && options.operationName.length > 0
    ? options.operationName
    : undefined;
  const operation = runtime.getOperationAST(document, name);
  if (!operation) {
    return {
      refused: true,
      status: 400,
      result: {
        errors: [
          codedError(
            'Could not resolve which operation to execute.',
            'OPERATION_RESOLUTION_FAILED',
          ),
        ],
      },
    };
  }

  return { document, validationErrors, operation };
}

/**
 * Execute a GraphQL query.
 *
 * @param query - The raw query document
 * @param options - The execution options
 * @returns The phase outcome carrying an HTTP status and the result
 */
export async function executeGraphql(
  query: string,
  options: ExecuteOptions & {
    operationName?: string;
    variableValues?: Record<string, unknown>;
    rootValue?: unknown;
    contextValue?: unknown;
    method?: 'GET' | 'POST';
  },
): Promise<ExecutionPhaseOutcome> {
  const { runtime, schema, documentCache, validationRules } = options;

  // Parse (cache hit reuses both the document and its validation result).
  const cached = documentCache.get(query);
  let document: GraphqlDocumentNodeLike;
  let validationErrors: GraphqlGraphQLErrorLike[] | null;

  if (cached) {
    document = cached.document;
    validationErrors = cached.validationErrors;
  } else {
    try {
      document = runtime.parse(query);
    } catch (e) {
      return { status: 400, executed: false, result: { errors: [toParseError(e)] } };
    }
    validationErrors = null;
  }

  // Operation-kind guard: after parse, before validate — so a refused operation
  // never pays for validation.
  const guard = checkOperation(runtime, document, {
    ...(options.operationName ? { operationName: options.operationName } : {}),
    ...(options.method ? { method: options.method } : {}),
    transport: 'http',
  });
  if (guard) {
    return guard as ExecutionPhaseOutcome;
  }

  if (!cached) {
    validationErrors = runtime.validate(schema, document, validationRules);
    documentCache.set(query, { document, validationErrors });
  }

  if (validationErrors && validationErrors.length > 0) {
    return { status: 400, executed: false, result: { errors: validationErrors } };
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

  const result = await runtime.execute(execArgs);

  // The operation ran. Field errors — including one that nulls `data` — are not
  // request errors, so this is a 200 even under strict negotiation.
  return { status: 200, executed: true, result };
}
