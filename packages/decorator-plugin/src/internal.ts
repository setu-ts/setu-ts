/**
 * Internal helpers shared across the decorator modules and the plugin.
 *
 * Not exported from the package barrel — these are implementation details.
 *
 * @module
 */
import type {
  Constructor,
  HandlerResult,
  IMiddleware,
  MiddlewareFunction,
} from '@hono-enterprise/common';

/**
 * A middleware value accepted by pipeline decorators: either a bare
 * {@linkcode MiddlewareFunction} or a class implementing
 * {@linkcode IMiddleware}.
 *
 * @since 0.1.0
 */
export type MiddlewareLike = MiddlewareFunction | (new () => IMiddleware);

/**
 * Normalizes a {@linkcode MiddlewareLike} into a bare
 * {@linkcode MiddlewareFunction}. A class implementing `IMiddleware` is
 * wrapped so a fresh instance is constructed per invocation and its `handle`
 * method is called.
 *
 * @param mw - The middleware function or class
 * @returns A middleware function
 * @throws {TypeError} If `mw` is not a function
 * @since 0.1.0
 */
export function normalizeMiddleware(mw: MiddlewareLike): MiddlewareFunction {
  if (typeof mw !== 'function') {
    throw new TypeError('Middleware must be a function or a class implementing IMiddleware.');
  }
  const proto = (mw as { prototype?: unknown }).prototype;
  if (
    proto !== null &&
    typeof proto === 'object' &&
    typeof (proto as { handle?: unknown }).handle === 'function'
  ) {
    const Ctor = mw as new () => IMiddleware;
    return (ctx, next): void | HandlerResult | Promise<void | HandlerResult> => {
      const instance = new Ctor();
      return instance.handle(ctx, next);
    };
  }
  return mw as MiddlewareFunction;
}

/**
 * Joins path segments into a single normalized path with exactly one leading
 * slash and no duplicate or trailing slashes. Empty segments are dropped.
 *
 * @param parts - Path segments (version, base path, route path, …)
 * @returns The normalized joined path
 * @since 0.1.0
 */
export function joinPaths(...parts: readonly string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    for (const seg of trimmed.split('/')) {
      if (seg !== '') {
        segments.push(seg);
      }
    }
  }
  return '/' + segments.join('/');
}

/**
 * Type guard for the opaque {@linkcode HandlerResult} brand returned by
 * `IResponse` terminal methods. A controller method that builds its own
 * response returns such a value.
 *
 * @param value - The value to test
 * @returns `true` if the value is a `HandlerResult`
 * @since 0.1.0
 */
export function isHandlerResult(value: unknown): value is HandlerResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __handlerResult?: unknown }).__handlerResult === true
  );
}

/**
 * Resolves the class constructor from the prototype handed to a method or
 * parameter decorator (legacy decorators pass the prototype as `target`).
 *
 * @param target - The prototype object from a decorator callback
 * @returns The class constructor
 * @since 0.1.0
 */
export function protoToCtor(target: object): Constructor {
  return (target as { constructor: Constructor }).constructor;
}

/**
 * Returns a class's name, or `'anonymous'` when unavailable (e.g. a class
 * created without a binding). Used to derive a default service token.
 *
 * @param target - The class constructor
 * @returns The class name, or `'anonymous'`
 * @since 0.1.0
 */
export function className(target: Constructor): string {
  return (target as unknown as { name?: string }).name ?? 'anonymous';
}
