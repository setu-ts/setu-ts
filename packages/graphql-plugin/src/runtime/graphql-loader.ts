/**
 * GraphQL runtime loader — inject-or-lazy pattern.
 *
 * @module
 */

import type { GraphqlModuleLike, GraphqlRuntime } from '../interfaces/graphql-runtime.ts';
import { GraphqlRuntimeLoadError } from '../errors/graphql-errors.ts';

/**
 * Adapt a graphql module to the internal runtime interface.
 *
 * This is a pure function that wraps the graphql module exports.
 */
export function adaptGraphqlModule(module: GraphqlModuleLike): GraphqlRuntime {
  return {
    parse: module.parse as unknown as GraphqlRuntime['parse'],
    validate: module.validate as unknown as GraphqlRuntime['validate'],
    execute: module.execute as unknown as GraphqlRuntime['execute'],
    subscribe: module.subscribe as unknown as GraphqlRuntime['subscribe'],
    buildSchema: module.buildSchema as unknown as GraphqlRuntime['buildSchema'],
    validateSchema: module.validateSchema as unknown as GraphqlRuntime['validateSchema'],
    getOperationAST: module.getOperationAST as unknown as GraphqlRuntime['getOperationAST'],
    GraphQLError: module.GraphQLError as unknown as GraphqlRuntime['GraphQLError'],
    NoSchemaIntrospectionCustomRule: module
      .NoSchemaIntrospectionCustomRule as unknown as GraphqlRuntime[
        'NoSchemaIntrospectionCustomRule'
      ],
    specifiedRules: module.specifiedRules as unknown as GraphqlRuntime['specifiedRules'],
  };
}

/**
 * Default importer function that performs the actual import.
 */
const defaultImporter = async (): Promise<GraphqlModuleLike> => {
  const mod = await import('npm:graphql@^16');
  return {
    parse: mod.parse as unknown as GraphqlModuleLike['parse'],
    validate: mod.validate as unknown as GraphqlModuleLike['validate'],
    execute: mod.execute as unknown as GraphqlModuleLike['execute'],
    subscribe: mod.subscribe as unknown as GraphqlModuleLike['subscribe'],
    buildSchema: mod.buildSchema as unknown as GraphqlModuleLike['buildSchema'],
    validateSchema: mod.validateSchema as unknown as GraphqlModuleLike['validateSchema'],
    getOperationAST: mod.getOperationAST as unknown as GraphqlModuleLike['getOperationAST'],
    GraphQLError: mod.GraphQLError as unknown as GraphqlModuleLike['GraphQLError'],
    NoSchemaIntrospectionCustomRule: mod
      .NoSchemaIntrospectionCustomRule as unknown as GraphqlModuleLike[
        'NoSchemaIntrospectionCustomRule'
      ],
    specifiedRules: mod.specifiedRules as unknown as GraphqlModuleLike['specifiedRules'],
  };
};

/**
 * Load the graphql runtime, either from an injected module or lazily.
 *
 * @param importer - Optional custom importer function
 * @returns The adapted graphql runtime
 * @throws {GraphqlRuntimeLoadError} If loading fails
 */
export async function loadGraphqlModule(
  importer = defaultImporter,
): Promise<GraphqlRuntime> {
  try {
    const module = await importer();
    return adaptGraphqlModule(module);
  } catch (error) {
    if (error instanceof GraphqlRuntimeLoadError) {
      throw error;
    }
    throw new GraphqlRuntimeLoadError('npm:graphql@^16', error);
  }
}
