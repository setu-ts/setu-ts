/**
 * GraphQL service implementation.
 *
 * @module
 */

import type {
  GraphqlExecutionOutcome,
  GraphqlExecutionResult,
  GraphqlRequestParams,
  IGraphqlService,
  IRequestContext,
} from '@hono-enterprise/common';
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
  #validationRules: unknown[];
  #maxDepth: number;
  #introspection: boolean;
  #maskInternalErrors: boolean;
  #formatError: (error: unknown) => unknown;
  #buildContext: ((input: GraphqlContextInput) => unknown | Promise<unknown>) | null;
  #rootValue?: unknown;

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
    },
  ) {
    this.#runtime = runtime;
    this.#schema = schema;
    this.#endpoint = options.endpoint;
    this.#documentCache = new DocumentCache(options.documentCacheSize);
    this.#validationRules = options.validationRules ?? [];
    this.#maxDepth = options.maxDepth;
    this.#introspection = options.introspection;
    this.#maskInternalErrors = options.maskInternalErrors;
    this.#formatError = options.formatError ?? ((_e: unknown) => undefined);
    this.#buildContext = options.buildContext ?? null;
    this.#rootValue = options.rootValue;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get cachedDocumentCount(): number {
    return this.#documentCache.size;
  }

  async execute(
    params: GraphqlRequestParams,
    requestContext?: IRequestContext,
  ): Promise<GraphqlExecutionOutcome> {
    // Build context
    let contextValue: unknown;
    if (this.#buildContext !== null) {
      contextValue = await this.#buildContext({
        services: requestContext?.services ?? {},
        request: requestContext?.request,
      });
    } else {
      const defaultContext: DefaultGraphqlContext = {
        services: requestContext?.services ?? {},
        requestContext: requestContext,
        user: (requestContext?.request as { user?: unknown })?.user,
        tenant: (requestContext?.request as { tenant?: unknown })?.tenant,
      };
      contextValue = defaultContext;
    }

    // Execute
    const result = await executeGraphql(params.query, {
      schema: this.#schema,
      runtime: this.#runtime,
      documentCache: this.#documentCache,
      validationRules: this.#buildValidationRules(),
      maxDepth: this.#maxDepth,
      introspection: this.#introspection,
      operationName: params.operationName ?? '',
      variableValues: params.variables ?? {},
      contextValue,
      rootValue: this.#rootValue,
    });

    // Mask errors
    const logger = (requestContext as { logger?: { error: (m: string, e?: unknown) => void } })
      ?.logger;
    const maskErrorsOptions = {
      maskInternalErrors: this.#maskInternalErrors,
      formatError: this.#formatError,
      ...(logger && { logger }),
    };
    const masked = maskErrors(result, maskErrorsOptions);

    return {
      status: 200,
      result: masked as GraphqlExecutionResult,
    };
  }

  #buildValidationRules(): unknown[] {
    const rules: unknown[] = [...this.#validationRules];

    // Add depth limit rule
    if (this.#maxDepth > 0) {
      rules.push(createDepthLimitRule(this.#maxDepth)());
    }

    // Add introspection rule if disabled
    if (!this.#introspection) {
      rules.push(this.#runtime.NoSchemaIntrospectionCustomRule);
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
