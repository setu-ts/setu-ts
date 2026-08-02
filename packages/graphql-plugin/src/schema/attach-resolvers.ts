/**
 * Resolver attachment for schema-first construction.
 *
 * Attaches resolvers from a resolver map to schema fields by mutation.
 *
 * @module
 */

import type {
  GraphqlAbstractTypeLike,
  GraphqlInterfaceTypeLike,
  GraphqlObjectTypeLike,
  GraphqlSchemaLike,
} from '../interfaces/graphql-runtime.ts';
import type { ResolverMap } from '../interfaces/options.ts';
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
    const type = schema.getType(typeName);
    if (!type) {
      throw new GraphqlSchemaError(
        `Resolver map references unknown type: "${typeName}"`,
      );
    }

    // Check if it's an object type
    const objectType = type as GraphqlObjectTypeLike;
    if (!objectType.getFields) {
      // It's a scalar or other non-object type
      throw new GraphqlSchemaError(
        `Cannot attach resolvers to scalar type: "${typeName}"`,
      );
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

      // Attach __resolveType to interface/union types
      // In graphql@16, abstract types (interfaces/unions) have a resolveType property
      const abstractType = type as GraphqlAbstractTypeLike & { resolveType?: unknown };
      if (abstractType) {
        // Check if this is an interface or union by checking if getType returns an interface type
        const interfaceType = type as GraphqlInterfaceTypeLike;
        if (typeof interfaceType.getFields === 'function') {
          // It's an interface type - attach resolveType
          abstractType.resolveType = fieldResolvers.__resolveType;
        } else {
          // It might be a union - still try to attach resolveType
          abstractType.resolveType = fieldResolvers.__resolveType;
        }
      }
    }
  }
}
