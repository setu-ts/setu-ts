/**
 * Internal GraphQL runtime interface.
 *
 * @module
 * @internal
 */

/**
 * Structural facade for a graphql@16 schema.
 *
 * The member signatures mirror what the real `GraphQLSchema` produces so that
 * a genuine schema is assignable here without a cast (M70i X6-3). graphql@16
 * returns `Maybe<T>` (`T | null | undefined`) from its type getters and
 * `ReadonlyArray` from its plural getters, so the facade admits both. `toAST`
 * is optional: no `src` reader consumes it, and the real `GraphQLSchema` does
 * not expose it, so requiring it excluded every schema the library builds.
 */
export interface GraphqlSchemaLike {
  getQueryType(): GraphqlObjectTypeLike | null | undefined;
  getMutationType(): GraphqlObjectTypeLike | null | undefined;
  getSubscriptionType(): GraphqlObjectTypeLike | null | undefined;
  getType(name: string): GraphqlNamedTypeLike | null | undefined;
  getPossibleTypes(abstractType: GraphqlAbstractTypeLike): readonly GraphqlObjectTypeLike[];
  getDirectives(): readonly GraphqlDirectiveLike[];
  getDirective(name: string): GraphqlDirectiveLike | null | undefined;
  toAST?(): unknown;
}

export interface GraphqlObjectTypeLike {
  name: string;
  getFields(): Record<string, GraphqlFieldLike>;
  getInterfaces(): readonly GraphqlInterfaceTypeLike[];
}

/**
 * A schema field. `resolve` and `subscribe` are declared with method syntax
 * (bivariant under `strictFunctionTypes`) so a real graphql field resolver —
 * whose `info` parameter is the concrete `GraphQLResolveInfo`, not `unknown` —
 * stays assignable. `args` is `unknown` because graphql@16 models it as an
 * argument *map*, not the array an earlier draft of this facade assumed, and
 * no `src` reader inspects it.
 */
export interface GraphqlFieldLike {
  name: string;
  type: GraphqlOutputTypeLike;
  /**
   * The field's resolver, typed `unknown` on purpose. graphql@16 types it as
   * `Maybe<GraphQLFieldResolver<TSource, TContext, TArgs, unknown>>` — a
   * nullable four-argument function whose `info` parameter is the concrete
   * `GraphQLResolveInfo`. No structural facade can name that type without
   * importing `graphql`, and a facade function type would still reject the
   * real resolver under `strictFunctionTypes` (contravariant `info`). The
   * plugin only ever *assigns* to this slot (via a cast in
   * `attach-resolvers.ts`); it never invokes it, so `unknown` loses nothing.
   */
  resolve?: unknown;
  /**
   * The event-source factory for a subscription field.
   *
   * graphql reads this — NOT `resolve` — to obtain the async iterable a
   * subscription streams from. Assigning a `{ subscribe }` entry to `resolve`
   * leaves this `undefined` and makes `graphql.subscribe()` throw
   * "Subscription field must return Async Iterable".
   *
   * `unknown` for the same reason as {@linkcode resolve}: the real
   * `GraphQLField`'s `subscribe` is a nullable function whose `info`
   * parameter is the concrete `GraphQLResolveInfo`, which no facade can
   * name. The plugin only assigns to this slot, never invokes it.
   */
  subscribe?: unknown;
  args: unknown;
}

export interface GraphqlArgumentLike {
  name: string;
  type: GraphqlInputTypeLike;
  defaultValue?: unknown;
}

export interface GraphqlInterfaceTypeLike {
  name: string;
  getFields(): Record<string, GraphqlFieldLike>;
}

export interface GraphqlAbstractTypeLike {
  name: string;
}

export interface GraphqlNamedTypeLike {
  name: string;
}

/**
 * Structural facade for a graphql@16 scalar type, exposing the three
 * settable resolver properties.
 *
 * @since 0.3.0
 */
export interface GraphqlScalarTypeLike extends GraphqlNamedTypeLike {
  serialize?: (value: unknown) => unknown;
  parseValue?: (value: unknown) => unknown;
  parseLiteral?: (node: unknown, variables?: Record<string, unknown> | null) => unknown;
}

/**
 * A graphql@16 output type: a named type, or a list / non-null wrapper around
 * one. The wrappers carry no `name`, so this is permissive rather than
 * `{ name: string }`; no `src` reader inspects a field's declared type.
 */
export type GraphqlOutputTypeLike = unknown;
export type GraphqlInputTypeLike = unknown;

export type GraphqlFieldResolverLike = (
  source: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => unknown;

export type GraphqlSubscribeFieldLike = (
  source: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

/**
 * A parsed GraphQL document. graphql@16 exposes `definitions` as a
 * `ReadonlyArray`, so the facade mirrors that.
 */
export interface GraphqlDocumentNodeLike {
  kind: string;
  definitions: readonly GraphqlDefinitionNodeLike[];
}

export interface GraphqlDefinitionNodeLike {
  kind: string;
  operation?: string | null;
  name?: { value: string } | null;
  selectionSet?: { selections: readonly GraphqlSelectionNodeLike[] } | null;
}

export interface GraphqlSelectionNodeLike {
  kind: string;
  name?: { value: string } | null;
  selectionSet?: { selections: readonly GraphqlSelectionNodeLike[] } | null;
  alias?: { value: string } | null;
  arguments?: readonly { name: { value: string }; value: unknown }[] | null;
}

export interface GraphqlDirectiveLike {
  name: string;
  /**
   * graphql@16 types directive locations as a `ReadonlyArray<DirectiveLocation>`
   * (a string union), not numbers. No `src` reader inspects them, so the facade
   * admits `unknown` elements to keep a real `GraphQLDirective` assignable.
   */
  locations: readonly unknown[];
  args: unknown;
}

/**
 * A graphql@16 error. graphql@16 exposes `locations`/`path` as
 * `ReadonlyArray` and `toJSON()` returns a formatted error whose `path` and
 * `locations` are also `ReadonlyArray`, so the facade admits `readonly`
 * arrays throughout.
 */
export interface GraphqlGraphQLErrorLike {
  message: string;
  /**
   * graphql@16 types these as `T | undefined` (present, possibly undefined),
   * so under `exactOptionalPropertyTypes` the facade must admit `undefined`
   * explicitly for a real `GraphQLError` to be assignable.
   */
  locations?: ReadonlyArray<{ line: number; column: number }> | undefined;
  path?: ReadonlyArray<string | number> | undefined;
  extensions?: Record<string, unknown> | undefined;
  originalError?: Error | undefined;
  toJSON(): {
    message: string;
    locations?: ReadonlyArray<{ line: number; column: number }> | undefined;
    path?: ReadonlyArray<string | number> | undefined;
    extensions?: Record<string, unknown> | undefined;
  };
}

/**
 * A graphql@16 execution result. graphql@16 types `errors` as a
 * `ReadonlyArray`, so the facade mirrors that; `data` is `null` when a
 * request-level error occurred.
 */
export interface GraphqlExecutionResultLike {
  data?: Record<string, unknown> | null;
  errors?: readonly GraphqlGraphQLErrorLike[];
}

/**
 * The outcome of `graphql.subscribe()`: an async iterable of results for a
 * live subscription, or a single result carrying `{ errors }` when the event
 * stream could not be created.
 */
export type GraphqlSubscribeResultLike =
  | GraphqlExecutionResultLike
  | AsyncIterable<GraphqlExecutionResultLike>;

/**
 * The adapted graphql runtime interface.
 *
 * `parse` and `buildSchema` accept `unknown` as their source so the real
 * `graphql` module — whose `parse`/`buildSchema` take `string | Source` — is
 * assignable without a cast (M70i X6-3). `execute`/`subscribe` return
 * `T | Promise<T>` because graphql@16's `PromiseOrValue` may resolve
 * synchronously.
 */
export interface GraphqlRuntime {
  parse(source: unknown): GraphqlDocumentNodeLike;
  validate(
    schema: GraphqlSchemaLike,
    document: GraphqlDocumentNodeLike,
    rules?: readonly unknown[],
  ): readonly GraphqlGraphQLErrorLike[];
  execute(args: {
    schema: GraphqlSchemaLike;
    document: GraphqlDocumentNodeLike;
    rootValue?: unknown;
    contextValue?: unknown;
    /**
     * graphql@16 types this `Maybe<{ readonly [variable: string]: unknown }>`
     * — a readonly index that may be `null` or `undefined`. The facade admits
     * all three so the real module's `ExecutionArgs` is a subtype of this.
     */
    variableValues?: Readonly<Record<string, unknown>> | null | undefined;
    /** graphql@16 types this `Maybe<string>` (`string | null | undefined`). */
    operationName?: string | null | undefined;
  }): GraphqlExecutionResultLike | Promise<GraphqlExecutionResultLike>;
  subscribe(args: {
    schema: GraphqlSchemaLike;
    document: GraphqlDocumentNodeLike;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: Readonly<Record<string, unknown>> | null | undefined;
    operationName?: string | null | undefined;
  }): GraphqlSubscribeResultLike | Promise<GraphqlSubscribeResultLike>;
  buildSchema(source: unknown): GraphqlSchemaLike;
  validateSchema(schema: GraphqlSchemaLike): readonly GraphqlGraphQLErrorLike[];
  getOperationAST(
    document: GraphqlDocumentNodeLike,
    operationName?: string,
  ): GraphqlDefinitionNodeLike | null | undefined;
  /**
   * `options` is `undefined` (not a modeled object) so the real
   * `typeof GraphQLError` — whose constructor is
   * `new (message: string, options?: GraphQLErrorOptions)` — stays assignable:
   * contravariance requires the facade's `options` to be assignable to
   * `GraphQLErrorOptions | undefined`, and `undefined` is. The only `src`
   * caller (`depth-limit.ts`) passes the message alone.
   */
  GraphQLError: new (
    message: string,
    options?: undefined,
  ) => GraphqlGraphQLErrorLike;
  NoSchemaIntrospectionCustomRule: unknown;
  specifiedRules: readonly unknown[];
}

/**
 * The structural shape of a graphql@16 module — the **external** boundary
 * (M70i X6-3).
 *
 * This is deliberately looser than the internal {@linkcode GraphqlRuntime}:
 * it references only the public {@linkcode GraphqlSchemaLike} and `unknown`,
 * so a genuine `npm:graphql` module is assignable to it **without a cast** —
 * `adaptGraphqlModule(graphql)` type-checks, which is the X6-3 gate. The
 * precise structural types live on `GraphqlRuntime` (internal); the loader
 * bridges the two with a per-member cast, so nothing here is read at runtime.
 *
 * Declared with **method syntax**, not indexed access into
 * {@linkcode GraphqlRuntime}: an indexed access like `validate:
 * GraphqlRuntime['validate']` produces a property of function type, which
 * `strictFunctionTypes` checks contravariantly, so the real module's concrete
 * `GraphQLSchema`/`DocumentNode` parameters would reject the facade's
 * structural ones. Method syntax is checked bivariantly, which is what lets a
 * genuine `graphql` module assign here.
 */
export interface GraphqlModuleLike {
  /** Parse a query/mutation/subscription document. */
  parse(source: unknown): unknown;
  /** Validate a document against a schema; returns validation errors. */
  validate(schema: GraphqlSchemaLike, document: unknown, rules?: readonly unknown[]): unknown;
  /** Execute a document; the result carries `data` and/or `errors`. */
  execute(args: {
    schema: GraphqlSchemaLike;
    document: unknown;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: unknown;
    operationName?: string | null | undefined;
  }): unknown;
  /** Subscribe to a document; the result is an async iterable or a single error result. */
  subscribe(args: {
    schema: GraphqlSchemaLike;
    document: unknown;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: unknown;
    operationName?: string | null | undefined;
  }): unknown;
  /** Build a schema from SDL source. */
  buildSchema(source: unknown): GraphqlSchemaLike;
  /** Validate a schema; returns schema errors. */
  validateSchema(schema: GraphqlSchemaLike): unknown;
  /** Extract the operation definition for `operationName` from a document. */
  getOperationAST(document: unknown, operationName?: string | null | undefined): unknown;
  /**
   * The graphql `GraphQLError` constructor. `options` is `undefined` (not a
   * modeled object) so the real `typeof GraphQLError` — whose constructor is
   * `new (message: string, options?: GraphQLErrorOptions)` — stays assignable:
   * contravariance requires the facade's `options` to be assignable to
   * `GraphQLErrorOptions | undefined`, and `undefined` is.
   */
  readonly GraphQLError: new (message: string, options?: undefined) => unknown;
  /** The no-schema-introspection validation rule. */
  readonly NoSchemaIntrospectionCustomRule: unknown;
  /** The specified (built-in) validation rules. */
  readonly specifiedRules: readonly unknown[];
}
