/**
 * @module
 *
 * @hono-enterprise/graphql-plugin — GraphQL plugin for Hono Enterprise.
 *
 * This plugin provides schema-first and code-first GraphQL support
 * over the kernel router.
 */

// Plugin
export { GraphqlPlugin } from './plugin/graphql-plugin.ts';

// Service
export { GraphqlService } from './services/graphql-service.ts';

// Options and types
export type {
  DefaultGraphqlContext,
  FieldResolver,
  GraphqlCodeFirstOptions,
  GraphqlContextInput,
  GraphqlPluginOptions,
  GraphqlSchemaFirstOptions,
  ResolverMap,
} from './interfaces/options.ts';

// Runtime types
export type { GraphqlModuleLike, GraphqlSchemaLike } from './interfaces/graphql-runtime.ts';

// Errors
export { GraphqlRuntimeLoadError, GraphqlSchemaError } from './errors/graphql-errors.ts';

// Runtime loader
export { adaptGraphqlModule, loadGraphqlModule } from './runtime/graphql-loader.ts';

// UI
export { graphiqlHtml } from './ui/graphiql.ts';

// Security
export { createDepthLimitRule } from './security/depth-limit.ts';
