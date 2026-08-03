/**
 * Internal GraphQL runtime interface.
 *
 * @module
 * @internal
 */

/** Structural facade for graphql@16 types. */
export interface GraphqlSchemaLike {
  getQueryType(): GraphqlObjectTypeLike | null;
  getMutationType(): GraphqlObjectTypeLike | null;
  getSubscriptionType(): GraphqlObjectTypeLike | null;
  getType(name: string): GraphqlNamedTypeLike | null;
  getPossibleTypes(abstractType: GraphqlAbstractTypeLike): GraphqlObjectTypeLike[];
  getDirectives(): GraphqlDirectiveLike[];
  getDirective(name: string): GraphqlDirectiveLike | null;
  toAST(): unknown;
}

export interface GraphqlObjectTypeLike {
  name: string;
  getFields(): Record<string, GraphqlFieldLike>;
  getInterfaces(): GraphqlInterfaceTypeLike[];
}

export interface GraphqlFieldLike {
  name: string;
  type: GraphqlOutputTypeLike;
  resolve?: GraphqlFieldResolverLike;
  args: GraphqlArgumentLike[];
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

export type GraphqlOutputTypeLike = GraphqlNamedTypeLike;
export type GraphqlInputTypeLike = GraphqlNamedTypeLike;

export type GraphqlFieldResolverLike = (
  source: unknown,
  args: Record<string, unknown>,
  context: unknown,
  info: unknown,
) => unknown;

export interface GraphqlDocumentNodeLike {
  kind: string;
  definitions: GraphqlDefinitionNodeLike[];
}

export interface GraphqlDefinitionNodeLike {
  kind: string;
  operation?: string;
  name?: { value: string };
  selectionSet?: { selections: GraphqlSelectionNodeLike[] };
}

export interface GraphqlSelectionNodeLike {
  kind: string;
  name?: { value: string };
  selectionSet?: { selections: GraphqlSelectionNodeLike[] };
  alias?: { value: string };
  arguments?: { name: { value: string }; value: unknown }[];
}

export interface GraphqlDirectiveLike {
  name: string;
  locations: number[];
  args: GraphqlArgumentLike[];
}

export interface GraphqlGraphQLErrorLike {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
  originalError?: Error;
  toJSON(): {
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
    extensions?: Record<string, unknown>;
  };
}

export interface GraphqlExecutionResultLike {
  data?: Record<string, unknown> | null;
  errors?: GraphqlGraphQLErrorLike[];
}

export type GraphqlSubscribeResultLike =
  | GraphqlExecutionResultLike
  | AsyncIterable<GraphqlExecutionResultLike>;

/** The adapted graphql runtime interface. */
export interface GraphqlRuntime {
  parse(source: string | { source: string }): GraphqlDocumentNodeLike;
  validate(
    schema: GraphqlSchemaLike,
    document: GraphqlDocumentNodeLike,
    rules?: unknown[],
  ): GraphqlGraphQLErrorLike[];
  execute(args: {
    schema: GraphqlSchemaLike;
    document: GraphqlDocumentNodeLike;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: Record<string, unknown>;
    operationName?: string;
  }): Promise<GraphqlExecutionResultLike>;
  subscribe(args: {
    schema: GraphqlSchemaLike;
    document: GraphqlDocumentNodeLike;
    rootValue?: unknown;
    contextValue?: unknown;
    variableValues?: Record<string, unknown>;
    operationName?: string;
  }): Promise<GraphqlSubscribeResultLike>;
  buildSchema(source: string | { source: string }): GraphqlSchemaLike;
  validateSchema(schema: GraphqlSchemaLike): GraphqlGraphQLErrorLike[];
  getOperationAST(
    document: GraphqlDocumentNodeLike,
    operationName?: string,
  ): GraphqlDefinitionNodeLike | null;
  GraphQLError: new (
    message: string,
    options?: {
      nodes?: unknown[];
      source?: unknown;
      positions?: number[];
      path?: Array<string | number>;
      originalError?: Error;
      extensions?: Record<string, unknown>;
    },
  ) => GraphqlGraphQLErrorLike;
  NoSchemaIntrospectionCustomRule: unknown;
  specifiedRules: unknown[];
}

/** The structural shape of a graphql@16 module. */
export interface GraphqlModuleLike {
  parse: GraphqlRuntime['parse'];
  validate: GraphqlRuntime['validate'];
  execute: GraphqlRuntime['execute'];
  subscribe: GraphqlRuntime['subscribe'];
  buildSchema: GraphqlRuntime['buildSchema'];
  validateSchema: GraphqlRuntime['validateSchema'];
  getOperationAST: GraphqlRuntime['getOperationAST'];
  GraphQLError: GraphqlRuntime['GraphQLError'];
  NoSchemaIntrospectionCustomRule: GraphqlRuntime['NoSchemaIntrospectionCustomRule'];
  specifiedRules: GraphqlRuntime['specifiedRules'];
}
