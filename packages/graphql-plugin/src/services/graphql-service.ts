/**
 * GraphQL service implementation.
 *
 * @module
 */

import type {
  GraphqlExecutionOutcome,
  GraphqlExecutionResult,
  GraphqlOperationContext,
  GraphqlRequestParams,
  GraphqlSubscriptionOutcome,
  IGraphqlService,
  IPrincipal,
  IRequestContext,
  IServiceRegistry,
  ITenant,
} from '@setu-ts/common';
import type { GraphqlLogger } from '../interfaces/options.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../interfaces/graphql-runtime.ts';
import type { DefaultGraphqlContext, GraphqlContextInput } from '../interfaces/options.ts';
import { DocumentCache } from '../execution/document-cache.ts';
import { executeGraphql, toInternalError } from '../execution/executor.ts';
import { subscribeGraphql } from '../execution/subscribe.ts';
import { maskErrors } from '../security/mask-errors.ts';
import { createDepthLimitRule } from '../security/depth-limit.ts';

/** Options {@linkcode maskStream} forwards to {@linkcode maskErrors}. */
interface MaskOptions {
  maskInternalErrors: boolean;
  formatError?: (error: unknown) => unknown;
  logger?: GraphqlLogger;
}

/**
 * Structural guard for a value an `onConnect` hook may have written to
 * `conn.data` under the `'user'` key. The hook's contract is to store an
 * `IPrincipal`; anything else (a string id, a raw token) is dropped rather
 * than placed on a member typed `IPrincipal` — the context must never carry a
 * value that does not satisfy the type it is declared as.
 */
function isPrincipal(value: unknown): value is IPrincipal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** Structural guard for a value written to `conn.data` under `'tenant'`. */
function isTenant(value: unknown): value is ITenant {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/**
 * Wrap a live subscription so every emitted payload is masked, and a throw
 * from the source becomes a final masked error payload rather than a rejection
 * the transport has to invent a wire shape for.
 *
 * `return()` is forwarded to the source in `finally`, so a client disconnect
 * still runs a generator-based producer's own cleanup.
 */
async function* maskStream(
  source: AsyncIterable<GraphqlExecutionResult>,
  options: MaskOptions,
): AsyncGenerator<GraphqlExecutionResult, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) {
        return;
      }
      yield maskErrors(value, options) as GraphqlExecutionResult;
    }
  } catch (e) {
    yield maskErrors(
      { errors: [toInternalError(e)] },
      options,
    ) as GraphqlExecutionResult;
  } finally {
    await iterator.return?.();
  }
}

/**
 * GraphQL service implementation.
 */
export class GraphqlService implements IGraphqlService {
  #runtime: GraphqlRuntime;
  #schema: GraphqlSchemaLike;
  #endpoint: string;
  #documentCache: DocumentCache;
  #customValidationRules: unknown[] | undefined;
  #validationRules: unknown[]; // A1: built once at construction, reused per request
  #maxDepth: number;
  #introspection: boolean;
  #maskInternalErrors: boolean;
  #formatError: (error: unknown) => unknown;
  #buildContext: ((input: GraphqlContextInput) => unknown | Promise<unknown>) | null;
  #rootValue?: unknown;
  #logger: GraphqlLogger | undefined;
  /** Plugin-level service registry for building context on the WS path. */
  #serviceRegistry: IServiceRegistry;

  constructor(
    runtime: GraphqlRuntime,
    schema: GraphqlSchemaLike,
    options: {
      endpoint: string;
      documentCacheSize: number;
      validationRules?: unknown[];
      maxDepth: number;
      introspection: boolean;
      maskInternalErrors: boolean;
      formatError?: (error: unknown) => unknown;
      buildContext?: (input: GraphqlContextInput) => unknown | Promise<unknown>;
      rootValue?: unknown;
      /**
       * Sink for masked internal errors. Supplied by the plugin from
       * `IPluginContext.logger`; `IRequestContext` carries no logger, so this is
       * the only path by which a masked error reaches an operator.
       */
      logger?: GraphqlLogger;
      /** Plugin-level registry (for WS subscription context). */
      serviceRegistry: IServiceRegistry;
    },
  ) {
    this.#runtime = runtime;
    this.#schema = schema;
    this.#endpoint = options.endpoint;
    this.#documentCache = new DocumentCache(options.documentCacheSize);
    this.#customValidationRules = options.validationRules;
    this.#maxDepth = options.maxDepth;
    this.#introspection = options.introspection;
    this.#maskInternalErrors = options.maskInternalErrors;
    // formatError is only used when masking errors; default to identity when not masking
    this.#formatError = options.formatError ?? ((e: unknown) => e);
    this.#buildContext = options.buildContext ?? null;
    this.#rootValue = options.rootValue;
    this.#logger = options.logger;
    this.#serviceRegistry = options.serviceRegistry;

    // A1: Build validation rules once at construction time (not per request)
    this.#validationRules = this.#buildValidationRules();
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get cachedDocumentCount(): number {
    return this.#documentCache.size;
  }

  #buildContextValue(
    context: GraphqlOperationContext,
  ): GraphqlContextInput {
    // C4: `??` binds tighter than `?:`, so the original expression parsed as
    // `(requestContext?.services ?? connection) ? serviceRegistry : {}`.
    // Fix precedence so HTTP uses request-scoped services, WS uses the plugin
    // registry, and neither falls back to `{}`.
    const services = context.requestContext?.services ??
      (context.connection ? this.#serviceRegistry : {});
    const request = context.requestContext?.request;
    const connection = context.connection;
    const input: GraphqlContextInput = { services, request };
    if (connection) {
      input.connection = connection;
    }
    return input;
  }

  async execute(
    params: GraphqlRequestParams,
    requestContext?: IRequestContext,
    method?: 'GET' | 'POST',
  ): Promise<GraphqlExecutionOutcome> {
    // Build context
    let contextValue: unknown;
    const opContext: GraphqlOperationContext = requestContext ? { requestContext } : {};
    if (this.#buildContext !== null) {
      contextValue = await this.#buildContext(this.#buildContextValue(opContext));
    } else {
      const ctxInput = this.#buildContextValue(opContext);
      // The HTTP path: `requestContext` present, `connection` absent. Members
      // are added only when defined — `exactOptionalPropertyTypes` forbids
      // writing an explicit `undefined` into an optional member, and the
      // documented per-transport shape (X6-6) is about ABSENCE, not undefined.
      const defaultContext: DefaultGraphqlContext = {
        // `#buildContextValue` types its services as `unknown` (the custom
        // buildContext input is permissively typed); the value is always the
        // request-scoped registry or the plugin-level one, so this is sound.
        services: ctxInput.services as IServiceRegistry,
        ...(requestContext !== undefined && { requestContext }),
        ...(requestContext?.request.user !== undefined && {
          user: requestContext.request.user,
        }),
        ...(requestContext?.request.tenant !== undefined && {
          tenant: requestContext.request.tenant,
        }),
      };
      contextValue = defaultContext;
    }

    // Parse → operation guard → validate → execute. The executor owns the
    // status, so `execute()` and the HTTP route can never disagree about it.
    const outcome = await executeGraphql(params.query, {
      schema: this.#schema,
      runtime: this.#runtime,
      documentCache: this.#documentCache,
      validationRules: this.#validationRules, // A1: use pre-built rules
      operationName: params.operationName ?? '',
      variableValues: params.variables ?? {},
      contextValue,
      rootValue: this.#rootValue,
      ...(method && { method }),
    });

    const maskErrorsOptions = {
      maskInternalErrors: this.#maskInternalErrors,
      formatError: this.#formatError,
      ...(this.#logger && { logger: this.#logger }),
    };
    const masked = maskErrors(outcome.result, maskErrorsOptions);

    return {
      status: outcome.status,
      result: masked as GraphqlExecutionResult,
    };
  }

  async subscribe(
    params: GraphqlRequestParams,
    context?: GraphqlOperationContext,
  ): Promise<GraphqlSubscriptionOutcome> {
    // Build context
    let contextValue: unknown;
    const opContext = context ?? {};
    if (this.#buildContext !== null) {
      contextValue = await this.#buildContext(this.#buildContextValue(opContext));
    } else {
      const ctxInput = this.#buildContextValue(opContext);
      // The WS path (X6-6): `requestContext` is NOT synthesized from the
      // upgrade request — the runtime closes it once the handshake response is
      // returned, so a resolver reading `ctx.requestContext.response` or
      // awaiting `ctx.requestContext.signal` would get a plausible object with
      // wrong behaviour. It is declared absent instead, and the upgrade
      // request's headers/query live on `connection.headers` / `connection.query`.
      //
      // The old `Record<string, unknown>` escape is gone: the context is
      // annotated `DefaultGraphqlContext`, and members are added only when
      // defined (absence, not `undefined`, under `exactOptionalPropertyTypes`).
      const defaultContext: DefaultGraphqlContext = {
        // `#buildContextValue` types its services as `unknown` (the custom
        // buildContext input is permissively typed); the value is always the
        // plugin-level registry or the request-scoped one, so this is sound.
        services: ctxInput.services as IServiceRegistry,
        ...(opContext.requestContext !== undefined && {
          requestContext: opContext.requestContext,
        }),
        ...(opContext.requestContext?.request.user !== undefined && {
          user: opContext.requestContext.request.user,
        }),
        ...(opContext.requestContext?.request.tenant !== undefined && {
          tenant: opContext.requestContext.request.tenant,
        }),
        ...(opContext.connection !== undefined && {
          connection: opContext.connection,
          ...(isPrincipal(opContext.connection.data.get('user')) && {
            user: opContext.connection.data.get('user') as IPrincipal,
          }),
          ...(isTenant(opContext.connection.data.get('tenant')) && {
            tenant: opContext.connection.data.get('tenant') as ITenant,
          }),
        }),
      };
      contextValue = defaultContext;
    }

    const outcome = await subscribeGraphql(params.query, {
      schema: this.#schema,
      runtime: this.#runtime,
      documentCache: this.#documentCache,
      validationRules: this.#validationRules,
      ...(params.operationName ? { operationName: params.operationName } : {}),
      variableValues: params.variables ?? {},
      contextValue,
      rootValue: this.#rootValue,
    });

    // Apply masking to error/single results
    const maskErrorsOptions = {
      maskInternalErrors: this.#maskInternalErrors,
      formatError: this.#formatError,
      ...(this.#logger && { logger: this.#logger }),
    };

    if (outcome.kind === 'error') {
      const masked = maskErrors(outcome.result, maskErrorsOptions);
      return { kind: 'error', status: outcome.status, result: masked as GraphqlExecutionResult };
    }
    if (outcome.kind === 'single') {
      const masked = maskErrors(outcome.result, maskErrorsOptions);
      return { kind: 'single', status: outcome.status, result: masked as GraphqlExecutionResult };
    }

    // A live subscription's payloads are masked HERE, not in the transports:
    // masking is one capability, and a per-transport copy is how the WS and SSE
    // paths came to publish raw resolver errors while the HTTP path masked them.
    return {
      kind: 'stream',
      status: outcome.status,
      stream: maskStream(outcome.stream, maskErrorsOptions),
    };
  }

  /**
   * Build validation rules once at construction time.
   * A1: This is called once in the constructor, not per request.
   */
  #buildValidationRules(): unknown[] {
    // Start with GraphQL's standard validation rules
    const rules: unknown[] = [...this.#runtime.specifiedRules];

    // Add depth limit rule
    if (this.#maxDepth > 0) {
      // createDepthLimitRule returns a validation rule function (receives context, returns visitor)
      rules.push(createDepthLimitRule(this.#maxDepth, this.#runtime.GraphQLError));
    }

    // Add introspection rule if disabled
    if (!this.#introspection) {
      rules.push(this.#runtime.NoSchemaIntrospectionCustomRule);
    }

    // Application rules are appended LAST, per the milestone plan §3.8.
    if (this.#customValidationRules && this.#customValidationRules.length > 0) {
      rules.push(...this.#customValidationRules);
    }

    return rules;
  }

  /**
   * Clear the document cache.
   */
  clearCache(): void {
    this.#documentCache.clear();
  }
}
