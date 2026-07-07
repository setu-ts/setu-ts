/**
 * Validation decorators — attach validation schemas to routes. The schema is
 * stored on the route metadata and surfaced via `RouteDefinition.schema`; it
 * is enforced only when the ValidationPlugin (or another schema-aware
 * middleware) is registered. Without it, the schema is inert.
 *
 * @module
 */
import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

/**
 * Attaches a request body schema to the decorated route handler.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateBody(schema: unknown): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.body = schema;
    });
  };
}

/**
 * Attaches a query parameter schema to the decorated route handler.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateQuery(schema: unknown): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.query = schema;
    });
  };
}

/**
 * Attaches a path parameter schema to the decorated route handler.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateParams(schema: unknown): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.params = schema;
    });
  };
}
