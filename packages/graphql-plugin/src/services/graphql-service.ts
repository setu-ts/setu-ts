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
  #validationRules: unknown[]; // A1: built once at construction, reused per request
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
    this.#maxDepth = options.maxDepth;
    this.#introspection = options.introspection;
    this.#maskInternalErrors = options.maskInternalErrors;
    // formatError is only used when masking errors; default to identity when not masking
    this.#formatError = options.formatError ?? ((e: unknown) => e);
    this.#buildContext = options.buildContext ?? null;
    this.#rootValue = options.rootValue;

    // A1: Build validation rules once at construction time (not per request)
    this.#validationRules = this.#buildValidationRules();
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
    method?: 'GET' | 'POST',
  ): Promise<GraphqlExecutionOutcome> {
    // B6: Check operation kind with parse-based detection (before validate/execute)
    const operationKind = this.#checkOperationKind(params.query, params.operationName);
    if (operationKind === 'subscription') {
      // Subscription over HTTP → 400 for ANY method
      return {
        status: 400,
        result: {
          errors: [
            {
              message: 'Subscriptions are not supported over HTTP',
              extensions: { code: 'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP' },
            },
          ],
        },
      };
    }
    if (operationKind === 'mutation' && method === 'GET') {
      // Mutation over GET → 405
      return {
        status: 405,
        result: {
          errors: [
            {
              message: 'Mutations are not allowed over GET',
              extensions: { code: 'METHOD_NOT_ALLOWED' },
            },
          ],
        },
      };
    }

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
      validationRules: this.#validationRules, // A1: use pre-built rules
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

    // Check if this is a validation error (has errors but no data)
    // Validation errors should return 400, not 200
    const hasErrors = masked.errors && masked.errors.length > 0;
    const hasData = masked.data !== undefined && masked.data !== null;
    const isValidationError = hasErrors && !hasData;

    return {
      status: isValidationError ? 400 : 200,
      result: masked as GraphqlExecutionResult,
    };
  }

  /**
   * Build validation rules once at construction time.
   * A1: This is called once in the constructor, not per request.
   */
  #buildValidationRules(): unknown[] {
    // Start with GraphQL's standard validation rules
    const rules: unknown[] = [...this.#runtime.specifiedRules];

    // Add custom validation rules from options
    if (this.#validationRules && this.#validationRules.length > 0) {
      rules.push(...this.#validationRules);
    }

    // Add depth limit rule
    if (this.#maxDepth > 0) {
      // createDepthLimitRule returns a validation rule function (receives context, returns visitor)
      rules.push(createDepthLimitRule(this.#maxDepth, this.#runtime.GraphQLError));
    }

    // Add introspection rule if disabled
    if (!this.#introspection) {
      rules.push(this.#runtime.NoSchemaIntrospectionCustomRule);
    }

    return rules;
  }

  /**
   * Check operation kind using parse-based detection.
   * Returns undefined if parse fails (will be handled during execution).
   * B6: This replaces the text-based getOperationKindFromQuery.
   */
  #checkOperationKind(
    query: string,
    operationName?: string,
  ): 'query' | 'mutation' | 'subscription' | undefined {
    try {
      const document = this.#runtime.parse(query);
      const ast = this.#runtime.getOperationAST(document, operationName);
      if (!ast) {
        return undefined;
      }
      return (ast.operation as 'query' | 'mutation' | 'subscription') ?? undefined;
    } catch {
      // Parse error - will be caught during execution
      return undefined;
    }
  }

  /**
   * Clear the document cache.
   */
  clearCache(): void {
    this.#documentCache.clear();
  }
}
