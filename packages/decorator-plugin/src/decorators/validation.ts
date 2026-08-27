/**
 * Validation decorators — attach validation schemas to routes. The schema is
 * stored on the route metadata and surfaced via `RouteDefinition.schema`.
 *
 * When a provider for `CAPABILITIES.VALIDATION` (the ValidationPlugin, or a
 * replacement) is registered AND `DecoratorPlugin`'s `enforceSchemas` option
 * is not `false`, each decorated target ALSO gets that capability's enforcing
 * middleware appended LAST in the route's chain (innermost, after guards), so
 * an invalid request is rejected with `400` before the handler runs while
 * guard `401`/`403` precedence is preserved. Without such a provider the
 * schemas stay description-only (OpenAPI), and `DecoratorPlugin` logs one
 * warning per affected route naming `ValidationPlugin`.
 *
 * @module
 */
import { methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuMethodDecorator } from '../metadata/context-bridge.ts';

/**
 * Attaches a request body schema to the decorated route handler.
 *
 * The schema is enforced (invalid bodies answered with `400`) when a
 * `CAPABILITIES.VALIDATION` provider is registered and `enforceSchemas` is not
 * `false`; otherwise it remains description-only. See the module documentation.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateBody(schema: unknown): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.body = schema;
    });
  });
}

/**
 * Attaches a query parameter schema to the decorated route handler.
 *
 * The schema is enforced (invalid queries answered with `400`) when a
 * `CAPABILITIES.VALIDATION` provider is registered and `enforceSchemas` is not
 * `false`; otherwise it remains description-only. See the module documentation.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateQuery(schema: unknown): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.query = schema;
    });
  });
}

/**
 * Attaches a path parameter schema to the decorated route handler.
 *
 * The schema is enforced (invalid path parameters answered with `400`) when a
 * `CAPABILITIES.VALIDATION` provider is registered and `enforceSchemas` is not
 * `false`; otherwise it remains description-only. See the module documentation.
 *
 * @param schema - Validation schema (Zod schema by convention)
 * @returns A method decorator
 * @since 0.1.0
 */
export function ValidateParams(schema: unknown): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      if (meta.schema === undefined) {
        meta.schema = {};
      }
      meta.schema.params = schema;
    });
  });
}
