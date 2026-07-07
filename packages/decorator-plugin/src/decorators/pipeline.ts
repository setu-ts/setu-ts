/**
 * Pipeline decorators — attach guards, interceptors, and error filters to
 * controllers and routes.
 *
 * Each accepts bare {@linkcode MiddlewareFunction}s or classes implementing
 * {@linkcode IMiddleware} (instantiated per invocation). Class-level
 * decorators apply to every route in the controller; method-level decorators
 * append after the class-level entries. At registration the plugin composes
 * them, in order: guards, interceptors, middleware, filters (class-level
 * before method-level within each band).
 *
 * @module
 */
import type { Constructor } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { normalizeMiddleware, protoToCtor } from '../internal.ts';
import type { MiddlewareLike } from '../internal.ts';

export type { MiddlewareLike } from '../internal.ts';

/**
 * Attaches guards to a controller or route. Guards run before the handler and
 * may short-circuit by responding without calling `next()`.
 *
 * @param middlewares - Guard functions or `IMiddleware` classes
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function UseGuards(...middlewares: MiddlewareLike[]): MethodDecorator & ClassDecorator {
  const normalized = middlewares.map(normalizeMiddleware);
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      metadataStore.mergeController(target as unknown as Constructor, { guards: normalized });
    } else {
      metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
        meta.guards.push(...normalized);
      });
    }
  };
}

/**
 * Attaches interceptors to a controller or route. Interceptors wrap the
 * handler invocation (pre- and post-processing via `next()`).
 *
 * @param middlewares - Interceptor functions or `IMiddleware` classes
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function UseInterceptors(
  ...middlewares: MiddlewareLike[]
): MethodDecorator & ClassDecorator {
  const normalized = middlewares.map(normalizeMiddleware);
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      metadataStore.mergeController(target as unknown as Constructor, { interceptors: normalized });
    } else {
      metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
        meta.interceptors.push(...normalized);
      });
    }
  };
}

/**
 * Attaches error filters to a controller or route. Filters run last in the
 * route middleware chain.
 *
 * @param middlewares - Filter functions or `IMiddleware` classes
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function UseFilters(...middlewares: MiddlewareLike[]): MethodDecorator & ClassDecorator {
  const normalized = middlewares.map(normalizeMiddleware);
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      metadataStore.mergeController(target as unknown as Constructor, { filters: normalized });
    } else {
      metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
        meta.filters.push(...normalized);
      });
    }
  };
}
