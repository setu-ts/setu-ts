/**
 * Request parameter decorators — extract values from the
 * {@linkcode IRequestContext} and inject them as handler arguments.
 *
 * The captured {@linkcode ParameterMetadata} is resolved at request time by
 * {@linkcode resolveParameters}.
 *
 * @module
 */
import { metadataStore } from '../metadata/metadata-store.ts';
import type { ParameterMetadata } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

/**
 * Injects the parsed JSON request body.
 *
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Body(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'body',
    });
  };
}

/**
 * Injects a query parameter value, or the whole query object when `name` is
 * omitted.
 *
 * @param name - Query parameter name; omit for the full query record
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Query(name?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    const param: ParameterMetadata = { index: parameterIndex, type: 'query' };
    if (name !== undefined) {
      param.name = name;
    }
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), param);
  };
}

/**
 * Injects a path parameter value.
 *
 * @param name - Path parameter name (must match a `:name` route segment)
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Param(name: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'param',
      name,
    });
  };
}

/**
 * Injects a request header value.
 *
 * @param name - Header name
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Header(name: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'header',
      name,
    });
  };
}

/**
 * Injects a cookie value parsed from the `Cookie` request header.
 *
 * @param name - Cookie name
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Cookie(name: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'cookie',
      name,
    });
  };
}
