/**
 * Tests for the SDK's default `fetch` receiver (X11-1, M70e §3.1/§3.2).
 *
 * The old default stored the bare global `fetch` on a private field and called
 * it as `this.#fetch(...)`. In a browser the receiver is then the `HttpClient`
 * instance, and the WebIDL receiver rule throws `Illegal invocation` on the
 * first request. This suite installs a `globalThis.fetch` that reproduces that
 * rule — `undefined`/global receiver allowed, anything else throws — and drives
 * a **default** client (no injected `fetch`) against it.
 *
 * The stand-in is the regression guard that reproduces the browser without a
 * browser; `test/e2e/default-transport.test.ts` is the real-socket half that
 * proves the default actually reaches a network.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createClient } from '../../src/sdk.ts';

/** A `fetch` that records calls and enforces the WebIDL receiver rule. */
function makeReceiverStrictFetch(calls: unknown[]): (
  input: RequestInfo,
  init?: RequestInit,
) => Promise<Response> {
  return function (this: unknown, input: RequestInfo, init?: RequestInit): Promise<Response> {
    // The browser throws when the receiver is neither `undefined` nor the
    // global object. A bare `fetch` stored on an instance and called as
    // `this.#fetch(...)` has the instance as its receiver — and fails here.
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}

describe('default fetch receiver (X11-1)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Restore the real global so this suite cannot leak into its neighbours.
    globalThis.fetch = originalFetch;
  });

  it('completes a request with the default fetch against a receiver-strict global', async () => {
    // A default client (no `fetch` option) must work when the global enforces
    // the WebIDL receiver rule. With the old `options.fetch ?? fetch` this
    // threw `Illegal invocation` — the receiver was the HttpClient instance.
    const calls: unknown[] = [];
    globalThis.fetch = makeReceiverStrictFetch(calls) as typeof globalThis.fetch;

    const client = createClient({ baseUrl: 'https://api.example.com' });
    const response = await client.request<{ ok: boolean }>({ method: 'GET', path: 'users/123' });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('still lets an explicitly injected fetch win over the global', async () => {
    // An injected `fetch` is untouched by the fix — it is used verbatim, so
    // the global stand-in is never consulted.
    const globalCalls: unknown[] = [];
    globalThis.fetch = makeReceiverStrictFetch(globalCalls) as typeof globalThis.fetch;
    const injectedCalls: unknown[] = [];

    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: (input, init) => {
        injectedCalls.push({ input, init });
        return Promise.resolve(
          new Response(JSON.stringify({ injected: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    const response = await client.request<{ injected: boolean }>({
      method: 'GET',
      path: 'users',
    });

    expect(response.data).toEqual({ injected: true });
    expect(injectedCalls).toHaveLength(1);
    // The global stand-in must NOT have been used.
    expect(globalCalls).toHaveLength(0);
  });

  it('uses a global installed after construction (call-time resolution)', async () => {
    // The default resolves `globalThis.fetch` at call time, not at
    // construction. A module-scope client built at import time, with the
    // global later replaced by a mocking library or polyfill, must be served
    // by the NEW global. A `fetch.bind(globalThis)` captured at construction
    // would keep calling the OLD one — this is the discriminator between the
    // two candidate fixes (plan §3.1).
    const firstCalls: unknown[] = [];
    globalThis.fetch = makeReceiverStrictFetch(firstCalls) as typeof globalThis.fetch;

    const client = createClient({ baseUrl: 'https://api.example.com' });

    // Replace the global AFTER the client was constructed.
    const secondCalls: unknown[] = [];
    globalThis.fetch = makeReceiverStrictFetch(secondCalls) as typeof globalThis.fetch;

    await client.request({ method: 'GET', path: 'users' });

    // The wrapper read the global at call time, so the replacement was used.
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls).toHaveLength(0);
  });
});
