/**
 * Schema building — two-arm construction (schema-first and code-first).
 *
 * @module
 */

import type { GraphqlSchemaLike } from '../interfaces/graphql-runtime.ts';
import type { GraphqlPluginOptions } from '../interfaces/options.ts';
import { GraphqlSchemaError } from '../errors/graphql-errors.ts';
import type { GraphqlRuntime } from '../interfaces/graphql-runtime.ts';

/**
 * Build a schema from the plugin options.
 *
 * Handles both schema-first (typeDefs + resolvers) and code-first
 * (pre-built schema) arms.
 *
 * @param options - The plugin options
 * @param runtime - The graphql runtime
 * @returns The built and validated schema
 * @throws {GraphqlSchemaError} If schema construction fails
 */
export function buildSchema(
  options: GraphqlPluginOptions,
  runtime: GraphqlRuntime,
): GraphqlSchemaLike {
  let schema: GraphqlSchemaLike;

  // Check for both arms being provided (runtime check for mutual exclusivity)
  const hasTypeDefs = 'typeDefs' in options && options.typeDefs !== undefined;
  const hasSchema = 'schema' in options && options.schema !== undefined;

  if (hasTypeDefs && hasSchema) {
    throw new GraphqlSchemaError(
      'Cannot provide both typeDefs and schema; choose one approach',
    );
  }

  // Schema-first arm
  if (hasTypeDefs) {
    if (!options.resolvers) {
      throw new GraphqlSchemaError(
        'Schema-first options require both typeDefs and resolvers',
      );
    }
    try {
      schema = runtime.buildSchema(options.typeDefs);
    } catch (error) {
      throw new GraphqlSchemaError(
        `Failed to build schema from SDL: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
  } // Code-first arm
  else if (hasSchema) {
    schema = options.schema;
  } else {
    throw new GraphqlSchemaError(
      'Invalid options: must provide either typeDefs+resolvers or schema',
    );
  }

  // Validate the schema
  const schemaErrors = runtime.validateSchema(schema);
  if (schemaErrors.length > 0) {
    const messages = schemaErrors.map((e) => e.message).join('; ');
    throw new GraphqlSchemaError(
      `Invalid schema: ${messages}`,
      schemaErrors,
    );
  }

  return schema;
}
