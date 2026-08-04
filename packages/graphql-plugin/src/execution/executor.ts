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

/** The operation kinds a resolved document can carry. */
export type GraphqlOperationKind = 'query' | 'mutation' | 'subscription';

/**
 * The result of {@linkcode checkOperation}: a refusal, or the resolved kind.
 *
 * Returning the kind is what lets the caller dispatch between `execute` and
 * `subscribe` without a second `getOperationAST` walk.
 */
export type OperationCheck =
  | { refused: ExecutionPhaseOutcome }
  | { refused: null; operation: GraphqlOperationKind };

/**
 * Guard the resolved operation: refuse an unresolvable operation, and — on the
 * `http` transport only — a subscription and a mutation over `GET`.
 *
 * Runs against an already-parsed document, so a cache hit costs no parse.
 *
 * @param runtime - The GraphQL runtime
 * @param document - The parsed document
 * @param options - Options controlling the transport arm
 * @returns A refusal to short-circuit with, or the resolved operation kind
 */
export function checkOperation(
  runtime: GraphqlRuntime,
  document: GraphqlDocumentNodeLike,
  options: {
    operationName?: string;
    method?: 'GET' | 'POST';
    transport: 'http' | 'stream';
  },
): OperationCheck {
  const name = options.operationName && options.operationName.length > 0
    ? options.operationName
    : undefined;
  const ast = runtime.getOperationAST(document, name);

  if (!ast) {
    return {
      refused: {
        status: 400,
        executed: false,
        result: {
          errors: [
            codedError(
              'Could not resolve which operation to execute. Provide `operationName`.',
              'OPERATION_RESOLUTION_FAILED',
            ),
          ],
        },
      },
    };
  }

  const operation = (ast.operation ?? 'query') as GraphqlOperationKind;

  // HTTP transport: refuse subscriptions and mutations over GET
  if (options.transport === 'http') {
    if (operation === 'subscription') {
      return {
        refused: {
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
        },
      };
    }

    if (operation === 'mutation' && options.method === 'GET') {
      return {
        refused: {
          status: 405,
          executed: false,
          result: {
            errors: [codedError('Mutations are not allowed over GET', 'METHOD_NOT_ALLOWED')],
          },
        },
      };
    }
  }

  return { refused: null, operation };
}

/**
 * The outcome of the shared parse → guard → validate prologue.
 */
export type PreparedDocument =
  | { ok: false; outcome: ExecutionPhaseOutcome }
  | { ok: true; document: GraphqlDocumentNodeLike; operation: GraphqlOperationKind };

/**
 * Parse, guard, and validate a document — the prologue both pipelines share.
 *
 * Owning it in ONE place is what keeps the document cache honest: the cache
 * holds the parsed document AND its validation result, so a repeat request
 * costs neither a parse nor a validate, on any transport. It also guarantees
 * that the depth limit, the introspection rule, and the application's own
 * validation rules apply identically over HTTP, WebSocket, and SSE.
 *
 * @param query - The raw query document
 * @param options - Execution options plus the transport arm
 * @returns A short-circuit outcome, or the document and its operation kind
 */
export function prepareDocument(
  query: string,
  options: ExecuteOptions & {
    operationName?: string;
    method?: 'GET' | 'POST';
    transport: 'http' | 'stream';
  },
): PreparedDocument {
  const { runtime, schema, documentCache, validationRules } = options;

  // Parse (a cache hit reuses both the document and its validation result).
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
      return {
        ok: false,
        outcome: { status: 400, executed: false, result: { errors: [toParseError(e)] } },
      };
    }
    validationErrors = null;
  }

  // Operation-kind guard: after parse, before validate — so a refused
  // operation never pays for validation.
  const check = checkOperation(runtime, document, {
    ...(options.operationName ? { operationName: options.operationName } : {}),
    ...(options.method ? { method: options.method } : {}),
    transport: options.transport,
  });
  if (check.refused) {
    return { ok: false, outcome: check.refused };
  }

  if (!cached) {
    validationErrors = runtime.validate(schema, document, validationRules);
    documentCache.set(query, { document, validationErrors });
  }

  if (validationErrors && validationErrors.length > 0) {
    return {
      ok: false,
      outcome: { status: 400, executed: false, result: { errors: validationErrors } },
    };
  }

  return { ok: true, document, operation: check.operation };
}

/**
 * Normalize a thrown execution failure into a maskable error.
 *
 * The `originalError` is what makes {@linkcode isExposable} report `false`, so
 * a throw escaping `execute`/`subscribe` is masked exactly like any other
 * internal error rather than reaching the client verbatim.
 */
export function toInternalError(thrown: unknown): GraphqlGraphQLErrorLike {
  const original = thrown instanceof Error ? thrown : new Error(String(thrown));
  const message = original.message.length > 0 ? original.message : 'Internal server error';
  return {
    message,
    originalError: original,
    toJSON() {
      return { message };
    },
  };
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
  const { runtime, schema } = options;

  const prepared = prepareDocument(query, { ...options, transport: 'http' });
  if (!prepared.ok) {
    return prepared.outcome;
  }
  const { document } = prepared;

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
