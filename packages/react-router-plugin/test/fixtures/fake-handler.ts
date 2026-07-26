/**
 * Fake `SsrRequestHandler` helpers for tests.
 *
 * @module
 * @since 0.1.0
 */

import type {
  RouterContextKey,
  RouterLoadContext,
  SsrRequestHandler,
} from '../../src/interfaces/index.ts';

/**
 * Stand-in for React Router's `RouterContextProvider`.
 *
 * Deliberately a NOMINAL class with the real `get`/`set` semantics copied from
 * `react-router@8`'s implementation: a hit returns the stored value, a miss
 * falls back to `defaultValue` when it is not `undefined`, and an unset key with
 * no default throws `No value found for context`. React Router checks
 * `instanceof RouterContextProvider`, so a fixture that accepted any object
 * would hide exactly the defect this fixture exists to catch.
 *
 * @since 0.2.0
 */
export class FakeRouterContextProvider implements RouterLoadContext {
  readonly #map = new Map<RouterContextKey<unknown>, unknown>();

  get<T>(key: RouterContextKey<T>): T {
    if (this.#map.has(key)) {
      return this.#map.get(key) as T;
    }
    if (key.defaultValue !== undefined) {
      return key.defaultValue;
    }
    throw new Error('No value found for context');
  }

  set<T>(key: RouterContextKey<T>, value: T): void {
    this.#map.set(key, value);
  }
}

/**
 * Creates the context factory the plugin's seam would return.
 *
 * @returns A factory producing a fresh {@linkcode FakeRouterContextProvider}
 * @since 0.2.0
 */
export function createFakeLoadContextFactory(): () => RouterLoadContext {
  return () => new FakeRouterContextProvider();
}

/**
 * Creates a simple fake RR handler that always returns the given response.
 *
 * Mirrors React Router's nominal guard: a context that is not a
 * {@linkcode FakeRouterContextProvider} instance throws, the way the real
 * `createRequestHandler` answers a 500 for a non-provider context.
 *
 * @param response - The response to return
 * @returns A fake handler function
 * @since 0.1.0
 */
export function createSimpleFakeHandler(response: Response): SsrRequestHandler {
  return (_request, loadContext) => {
    if (!(loadContext instanceof FakeRouterContextProvider)) {
      return Promise.reject(
        new Error(
          'Invalid `context` value provided to `handleRequest`. You must return ' +
            'an instance of `RouterContextProvider` from your `getLoadContext` function.',
        ),
      );
    }
    return Promise.resolve(response);
  };
}
