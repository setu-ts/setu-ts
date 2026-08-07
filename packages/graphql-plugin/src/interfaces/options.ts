/**
 * GraphQL plugin options and related types.
 *
 * @module
 */

import type { GraphqlConnectionInfo } from '@setu-ts/common';
import type { GraphqlModuleLike, GraphqlSchemaLike } from './graphql-runtime.ts';

/**
 * Resolver map for schema-first construction.
 *
 * Keys are type names, values are objects mapping field names to resolvers
 * or scalar resolver maps ({@linkcode GraphqlScalarResolver}).
 */
export type ResolverMap = Record<string, TypeResolverMap | GraphqlScalarResolver>;

/**
 * The resolver entries for one object or interface type.
 *
 * A field maps to a plain {@linkcode FieldResolver}, or — for a field of the
 * `Subscription` root type — to a {@linkcode SubscriptionResolver} carrying the
 * event source.
 *
 * @since 0.3.0
 */
export type TypeResolverMap = Record<
  string,
  | FieldResolver
  | SubscriptionResolver
  | (() => unknown) // __resolveType for interfaces
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
 * A subscription field's resolver pair.
 *
 * `subscribe` returns the async iterable the field streams from and is
 * attached to the schema field's `subscribe` slot; the optional `resolve` maps
 * each emitted payload to the field value, exactly as graphql defines it.
 *
 * Without this arm a subscription is unexpressible in the schema-first map:
 * an entry has to be a function, and assigning `{ subscribe }` to a field's
 * `resolve` leaves `subscribe` unset, which makes `graphql.subscribe()` throw
 * "Subscription field must return Async Iterable".
 *
 * @since 0.3.0
 */
export interface SubscriptionResolver {
  /** Produces the event source for this subscription field. */
  subscribe: (
    source: unknown,
    args: Record<string, unknown>,
    context: unknown,
    info: unknown,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  /** Maps each emitted payload to the field value. Optional. */
  resolve?: FieldResolver;
}

/**
 * Custom scalar resolver methods.
 *
 * Supply any subset of `serialize`, `parseValue`, and `parseLiteral`; omitted
 * members leave graphql's identity default in place.
 *
 * @since 0.3.0
 */
export interface GraphqlScalarResolver {
  /** Serialize an internal value to JSON-safe output. */
  serialize?(value: unknown): unknown;
  /** Parse a client input value (variable). */
  parseValue?(value: unknown): unknown;
  /**
   * Parse a literal AST value (inline argument).
   *
   * @param node - The literal AST node
   * @param variables - Variable values in scope, when graphql supplies them
   */
  parseLiteral?(node: unknown, variables?: Record<string, unknown> | null): unknown;
}

/**
 * Subscription transport configuration.
 *
 * @since 0.3.0
 */
export interface GraphqlSubscriptionsOptions {
  /**
   * WebSocket transport options. `false` disables WS subscriptions;
   * `{}` enables with defaults. Absent defaults to enabled when
   * `CAPABILITIES.WEBSOCKET` is available.
   */
  websocket?: GraphqlWsTransportOptions | false;
  /**
   * SSE transport options. `false` disables SSE subscriptions;
   * `{}` enables with defaults. Present by default.
   */
  sse?: GraphqlSseTransportOptions | false;
}

/**
 * WebSocket transport options for GraphQL subscriptions.
 *
 * @since 0.3.0
 */
export interface GraphqlWsTransportOptions {
  /** The WebSocket endpoint path; defaults to `` `${path}/ws` ``. */
  path?: string;
  /**
   * Milliseconds to wait for `connection_init` before closing with code 4408.
   * Default `3000`.
   */
  connectionInitWaitMs?: number;
  /**
   * Milliseconds between protocol `ping` frames. `0` disables.
   * Default `0`.
   */
  heartbeatMs?: number;
  /**
   * Called on `connection_init` BEFORE the ack. Returning `false` closes
   * the socket with `4403: Forbidden`. May write to `conn.data` to establish
   * identity for the default resolver context.
   */
  onConnect?: (
    info: GraphqlConnectionInfo,
  ) => false | void | Promise<false | void>;
}

/**
 * SSE transport options for GraphQL subscriptions.
 *
 * @since 0.3.0
 */
export interface GraphqlSseTransportOptions {
  /** The SSE endpoint path; defaults to `` `${path}/stream` ``. */
  path?: string;
  /**
   * Milliseconds between `:keep-alive` comment frames. `0` disables.
   * Default `0`.
   */
  heartbeatMs?: number;
}

/**
 * APQ (Automatic Persisted Queries) options.
 *
 * @since 0.3.0
 */
export interface GraphqlApqOptions {
  /** TTL in seconds for cache-store entries. Default `300`. */
  ttlSeconds?: number;
  /** Maximum entries in the in-memory LRU fallback. Default `1000`. */
  maxEntries?: number;
}

/**
 * The error sink the plugin hands to the service and the route handler.
 *
 * Structural on purpose: it is satisfied by `IPluginContext.logger` without the
 * plugin depending on the logger plugin.
 */
export interface GraphqlLogger {
  error(message: string, error?: unknown): void;
}

/**
 * Context input for custom context building.
 *
 * Widened in M51b to carry an optional {@linkcode GraphqlConnectionInfo} when
 * the operation arrives over a WebSocket subscription.
 */
export interface GraphqlContextInput {
  services: unknown;
  request?: unknown;
  /** Present when the operation arrives over a WebSocket subscription. */
  connection?: GraphqlConnectionInfo;
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

    /**
     * Subscription transport configuration. Absent → no transport routes are
     * registered (byte-identical to M51 behavior).
     *
     * @since 0.3.0
     */
    subscriptions?: GraphqlSubscriptionsOptions;

    /**
     * APQ (Automatic Persisted Queries) configuration. Absent → APQ disabled.
     *
     * @since 0.3.0
     */
    apq?: GraphqlApqOptions;

    /**
     * Maximum number of requests in a batch. `0` (default) disables batching;
     * an array body is still refused with `400`. Set above `0` to enable.
     *
     * @since 0.3.0
     */
    maxBatchSize?: number;
  };
