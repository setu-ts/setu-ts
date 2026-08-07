/**
 * @module
 *
 * @setu-ts/graphql-plugin — GraphQL plugin for Setu-TS.
 *
 * This plugin provides schema-first and code-first GraphQL support
 * over the kernel router, with subscription transports (WebSocket, SSE),
 * request batching, and Automatic Persisted Queries.
 */

// Plugin
export { GraphqlPlugin } from './plugin/graphql-plugin.ts';

// Service
export { GraphqlService } from './services/graphql-service.ts';

// Options and types
export type {
  DefaultGraphqlContext,
  FieldResolver,
  GraphqlApqOptions,
  GraphqlCodeFirstOptions,
  GraphqlContextInput,
  GraphqlPluginOptions,
  GraphqlScalarResolver,
  GraphqlSchemaFirstOptions,
  GraphqlSseTransportOptions,
  GraphqlSubscriptionsOptions,
  GraphqlWsTransportOptions,
  ResolverMap,
  SubscriptionResolver,
  TypeResolverMap,
} from './interfaces/options.ts';

// Re-export common types for single-package import
export type {
  GraphqlConnectionInfo,
  GraphqlExecutionResult,
  GraphqlFormattedError,
  GraphqlOperationContext,
  GraphqlRequestParams,
  GraphqlSubscriptionOutcome,
  IGraphqlService,
} from '@setu-ts/common';

// Runtime types
export type {
  GraphqlModuleLike,
  GraphqlScalarTypeLike,
  GraphqlSchemaLike,
} from './interfaces/graphql-runtime.ts';

// Errors
export { GraphqlRuntimeLoadError, GraphqlSchemaError } from './errors/graphql-errors.ts';

// Runtime loader
export { adaptGraphqlModule, loadGraphqlModule } from './runtime/graphql-loader.ts';

// UI
export { graphiqlHtml } from './ui/graphiql.ts';

// Security
export { createDepthLimitRule } from './security/depth-limit.ts';

// APQ
export { ApqResolver } from './apq/apq-resolver.ts';
export type { ApqResolveResult, IApqResolver } from './apq/apq-resolver.ts';
export { extractPersistedQuery, persistedQueryHash } from './apq/persisted-query.ts';

// SSE transport
export { encodeSseComment, encodeSseComplete, encodeSseEvent } from './transports/sse/sse-frame.ts';

// WS transport
export { GRAPHQL_TRANSPORT_WS } from './transports/ws/ws-protocol.ts';
