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
  IRequestContext,
  IServiceRegistry,
} from '@hono-enterprise/common';
import type { GraphqlLogger } from '../interfaces/options.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../interfaces/graphql-runtime.ts';
import type { DefaultGraphqlContext, GraphqlContextInput } from '../interfaces/options.ts';
import { DocumentCache } from '../execution/document-cache.ts';
import { executeGraphql } from '../execution/executor.ts';
import { maskErrors } from '../security/mask-errors.ts';
import { createDepthLimitRule } from '../security/depth-limit.ts';

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
    const services = context.requestContext?.services ??
        context.connection
      ? this.#serviceRegistry
      : {};
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
      const defaultContext: DefaultGraphqlContext = {
        services: ctxInput.services,
        requestContext: requestContext,
        user: requestContext ? (requestContext.request as { user?: unknown })?.user : undefined,
        tenant: requestContext
          ? (requestContext.request as { tenant?: unknown })?.tenant
          : undefined,
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
      const defaultContext: Record<string, unknown> = {
        services: ctxInput.services,
        requestContext: opContext.requestContext,
        user: opContext.requestContext
          ? (opContext.requestContext.request as { user?: unknown })?.user
          : opContext.connection?.data.get('user'),
        tenant: opContext.requestContext
          ? (opContext.requestContext.request as { tenant?: unknown })?.tenant
          : opContext.connection?.data.get('tenant'),
      };
      if (opContext.connection) {
        defaultContext.connection = opContext.connection;
      }
      contextValue = defaultContext;
    }

    const { subscribeGraphql } = await import('../execution/subscribe.ts');
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

    // Stream: masking applied lazily as results arrive
    // (the transport wraps the stream to mask each result)
    return outcome;
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
