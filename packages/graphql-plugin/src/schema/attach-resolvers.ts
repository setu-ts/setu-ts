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
import type {
  GraphqlFieldResolverLike,
  GraphqlSubscribeFieldLike,
} from '../interfaces/graphql-runtime.ts';
import type {
  GraphqlScalarResolver,
  ResolverMap,
  SubscriptionResolver,
} from '../interfaces/options.ts';
import { GraphqlSchemaError } from '../errors/graphql-errors.ts';

/**
 * Narrow a resolver-map entry to a subscription resolver.
 *
 * The discriminator is a callable `subscribe` member, which is the only shape
 * graphql can stream from.
 */
function isSubscriptionResolver(entry: unknown): entry is SubscriptionResolver {
  return typeof entry === 'object' && entry !== null &&
    typeof (entry as SubscriptionResolver).subscribe === 'function';
}

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

    // Check if it's an object type, scalar, or enum.
    // N2: `!getFields` also matches enum types (no fields), so we need a
    // precise discriminator. Object types have `getFields`, scalars have
    // `serialize`/`parseValue`/`parseLiteral`, enums have `values`.
    const objectType = type as GraphqlObjectTypeLike;
    const scalarType = type as GraphqlScalarTypeLike;
    const isObject = typeof objectType.getFields === 'function';
    const isScalar = typeof scalarType.serialize === 'function' ||
      typeof scalarType.parseValue === 'function' ||
      typeof scalarType.parseLiteral === 'function';
    const isEnum = 'values' in scalarType;

    if (isEnum) {
      // Enum types are not scalar-attached; skip.
      continue;
    }

    if (!isObject && isScalar) {
      // It's a scalar — attach scalar resolver methods
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

    if (!isObject) {
      // Unknown type without getFields, serialize, or values — skip.
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

      // A subscription field carries `{ subscribe, resolve? }`, and graphql
      // reads the event source from the field's own `subscribe` slot. Assigning
      // the whole entry to `resolve` — which is what this did before — leaves
      // `subscribe` unset, and `graphql.subscribe()` then throws
      // "Subscription field must return Async Iterable. Received: undefined."
      if (isSubscriptionResolver(resolver)) {
        field.subscribe = resolver.subscribe as GraphqlSubscribeFieldLike;
        if (typeof resolver.resolve === 'function') {
          field.resolve = resolver.resolve as GraphqlFieldResolverLike;
        }
        continue;
      }

      if (typeof resolver !== 'function') {
        throw new GraphqlSchemaError(
          `Resolver for "${typeName}.${fieldName}" must be a function, or an object ` +
            `carrying a \`subscribe\` function for a subscription field`,
        );
      }

      field.resolve = resolver as GraphqlFieldResolverLike;
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
