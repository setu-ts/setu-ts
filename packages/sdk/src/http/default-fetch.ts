/**
 * The SDK's one default transport: `globalThis.fetch`, resolved at CALL time
 * with the global as its receiver.
 *
 * Shared by `HttpClient` and `createObservedFetch` so both entry points use
 * the same implementation. A bare `fetch` stored on an object field loses its
 * receiver when called as a method, and browsers (and workerd) throw
 * `Illegal invocation` on it (X11-1); this wrapper ignores whatever receiver
 * it is called with. Reading the global at call time also picks up a
 * `globalThis.fetch` replaced after construction.
 *
 * @module
 * @internal
 */

/** The fetch-shaped transport the SDK delegates to. */
export type FetchTransport = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/**
 * Creates the default transport.
 *
 * @returns A function that calls the current `globalThis.fetch`
 * @internal
 */
export function createDefaultFetch(): FetchTransport {
  return (input, init) => globalThis.fetch(input, init);
}
