/**
 * GraphQL plugin options and related types.
 *
 * @module
 */

import type { GraphqlModuleLike, GraphqlSchemaLike } from './graphql-runtime.ts';

/**
 * Resolver map for schema-first construction.
 *
 * Keys are type names, values are objects mapping field names to resolvers.
 */
export type ResolverMap = Record<
  string,
  Record<
    string,
    FieldResolver | (() => unknown) // resolveType for interfaces
  >
>;

/**
 * A field resolver function.
 *
 * Matches the graphql@16 field resolver signature.
 */
export type FieldResolver = (
  source: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => unknown;

/**
 * Context input for custom context building.
 */
export interface GraphqlContextInput {
  services: unknown;
  request?: unknown;
}

/**
 * Default context shape that resolvers receive.
 */
export interface DefaultGraphqlContext {
  services: unknown;
  requestContext: unknown;
  user?: unknown;
  tenant?: unknown;
}

/**
 * Schema-first arm options.
 */
export interface GraphqlSchemaFirstOptions {
  /** SDL string defining the schema. */
  typeDefs: string;
  /** Resolver map to attach to the schema. */
  resolvers: ResolverMap;
  /** Disallow code-first option. */
  schema?: never;
}

/**
 * Code-first arm options.
 */
export interface GraphqlCodeFirstOptions {
  /** Pre-built schema from the application. */
  schema: GraphqlSchemaLike;
  /** Disallow schema-first options. */
  typeDefs?: never;
  resolvers?: never;
}

/**
 * Union of schema construction options — mutually exclusive arms.
 *
 * Supplying both arms results in a compile error due to the `?: never` fields.
 */
export type GraphqlPluginOptions =
  & (
    | GraphqlSchemaFirstOptions
    | GraphqlCodeFirstOptions
  )
  & {
    /**
     * Path for the GraphQL endpoint. Defaults to '/graphql'.
     */
    path?: string;

    /**
     * Enable GraphiQL UI. Defaults to true.
     */
    graphiql?: boolean;

    /**
     * Enable schema introspection. Defaults to true.
     */
    introspection?: boolean;

    /**
     * Maximum query depth. Defaults to 10. Set to 0 to disable.
     */
    maxDepth?: number;

    /**
     * Additional validation rules to append.
     */
    validationRules?: unknown[];

    /**
     * Mask internal errors. Defaults to true.
     */
    maskInternalErrors?: boolean;

    /**
     * Custom error formatter applied after masking.
     */
    formatError?: (error: unknown) => unknown;

    /**
     * Maximum number of documents to cache. Defaults to 1000. Set to 0 to disable.
     */
    documentCacheSize?: number;

    /**
     * Custom context builder. Receives services and request, returns context value.
     */
    buildContext?: (
      input: GraphqlContextInput,
    ) => unknown | Promise<unknown>;

    /**
     * Root value passed to execute.
     */
    rootValue?: unknown;

    /**
     * Injected graphql module to use instead of lazy loading.
     * Required when the application uses its own graphql copy.
     */
    graphqlModule?: GraphqlModuleLike;
  };
