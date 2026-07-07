/**
 * HTTP method decorators — declare route handlers on controller methods.
 *
 * Each decorator adds an HTTP verb + path binding to the method's metadata.
 * Multiple HTTP decorators on the same method produce multiple routes
 * sharing the method's other metadata (parameters, middleware, schemas, …).
 *
 * @module
 */
import type { HttpMethod } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

/**
 * A factory producing a method decorator that registers a route for a given
 * HTTP verb.
 *
 * @since 0.1.0
 */
export type HttpMethodDecorator = (path?: string) => MethodDecorator;

/**
 * Creates an HTTP method decorator for the given verb.
 *
 * @param method - The HTTP method
 * @returns A decorator factory
 */
function createMethodDecorator(method: HttpMethod): HttpMethodDecorator {
  return (path?: string): MethodDecorator => {
    return (target, propertyKey) => {
      metadataStore.addRouteBinding(protoToCtor(target), String(propertyKey), method, path ?? '');
    };
  };
}

/**
 * Registers a GET route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Get: HttpMethodDecorator = createMethodDecorator('GET');

/**
 * Registers a POST route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Post: HttpMethodDecorator = createMethodDecorator('POST');

/**
 * Registers a PUT route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Put: HttpMethodDecorator = createMethodDecorator('PUT');

/**
 * Registers a PATCH route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Patch: HttpMethodDecorator = createMethodDecorator('PATCH');

/**
 * Registers a DELETE route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Delete: HttpMethodDecorator = createMethodDecorator('DELETE');

/**
 * Registers a HEAD route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Head: HttpMethodDecorator = createMethodDecorator('HEAD');

/**
 * Registers an OPTIONS route on the decorated method.
 *
 * @param path - Route path (relative to the controller base); defaults to `''`
 * @since 0.1.0
 */
export const Options: HttpMethodDecorator = createMethodDecorator('OPTIONS');
