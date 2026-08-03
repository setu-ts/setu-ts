/**
 * Resolver attachment for schema-first construction.
 *
 * Attaches resolvers from a resolver map to schema fields by mutation.
 *
 * @module
 */

import type {
  GraphqlAbstractTypeLike,
  GraphqlObjectTypeLike,
  GraphqlScalarTypeLike,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { GraphqlScalarResolver, ResolverMap } from '../interfaces/options.ts';
import { GraphqlSchemaError } from '../errors/graphql-errors.ts';

/**
 * Attach resolvers from a resolver map to a schema.
 *
 * This mutates the schema's field resolvers directly. Throws if the
 * resolver map references unknown types, fields, or scalar types.
 *
 * @param schema - The schema to attach resolvers to
 * @param resolverMap - The resolver map
 * @throws {GraphqlSchemaError} If resolver attachment fails
 */
export function attachResolvers(
  schema: GraphqlSchemaLike,
  resolverMap: ResolverMap,
): void {
  for (const [typeName, fieldResolvers] of Object.entries(resolverMap)) {
    // Skip types that only have __resolveType — handled in the second loop
    const hasFieldResolvers = Object.keys(fieldResolvers).some(
      (k) => k !== '__resolveType',
    );
    if (!hasFieldResolvers) {
      continue;
    }

    const type = schema.getType(typeName);
    if (!type) {
      throw new GraphqlSchemaError(
        `Resolver map references unknown type: "${typeName}"`,
      );
    }

    // Check if it's an object type or scalar
    const objectType = type as GraphqlObjectTypeLike;
    if (!objectType.getFields) {
      // It's a scalar — attach scalar resolver methods
      const scalarType = type as GraphqlScalarTypeLike;
      const scalarResolver = fieldResolvers as GraphqlScalarResolver;
      if (typeof scalarResolver.serialize === 'function') {
        scalarType.serialize = scalarResolver.serialize;
      }
      if (typeof scalarResolver.parseValue === 'function') {
        scalarType.parseValue = scalarResolver.parseValue;
      }
      if (typeof scalarResolver.parseLiteral === 'function') {
        scalarType.parseLiteral = scalarResolver.parseLiteral;
      }
      continue;
    }

    const fields = objectType.getFields();
    for (const [fieldName, resolver] of Object.entries(fieldResolvers)) {
      // Skip __resolveType for now - handled separately
      if (fieldName === '__resolveType') {
        // This is for interface types
        continue;
      }

      const field = fields[fieldName];
      if (!field) {
        throw new GraphqlSchemaError(
          `Resolver map references unknown field: "${typeName}.${fieldName}"`,
        );
      }

      // Attach the resolver
      field.resolve = resolver as unknown as (
        source: unknown,
        args: Record<string, unknown>,
        context: unknown,
        info: unknown,
      ) => unknown;
    }
  }

  // Handle __resolveType for interface/union types (B5)
  for (const [typeName, fieldResolvers] of Object.entries(resolverMap)) {
    if ('__resolveType' in fieldResolvers && typeof fieldResolvers.__resolveType === 'function') {
      const type = schema.getType(typeName);
      if (!type) {
        throw new GraphqlSchemaError(
          `Resolver map references unknown type for __resolveType: "${typeName}"`,
        );
      }

      // In graphql@16 both abstract kinds — interfaces and unions — carry a
      // `resolveType` property, so the assignment is the same for each and no
      // branch on the kind is needed.
      const abstractType = type as GraphqlAbstractTypeLike & { resolveType?: unknown };
      abstractType.resolveType = fieldResolvers.__resolveType;
    }
  }
}
