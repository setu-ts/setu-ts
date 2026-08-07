/**
 * Tests for the default loadContext bridge.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal, IServiceRegistry } from '@setu-ts/common';
import type { IRequestContext } from '../../src/interfaces/index.ts';
import { applyDefaultLoadContext } from '../../src/handler/load-context.ts';
import { servicesContext, userContext } from '../../src/handler/context-keys.ts';
import { FakeRouterContextProvider } from '../fixtures/fake-handler.ts';

describe('load-context', () => {
  const registry = { get: () => undefined } as unknown as IServiceRegistry;

  // Build minimal IRequestContext using a partial mock (we only read
  // ctx.services and ctx.request.user).
  function buildCtx(principal?: IPrincipal): IRequestContext {
    return {
      id: 'req-1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/',
        path: '/',
        headers: new Headers(),
        user: principal,
        json: () => ({}),
        text: () => '',
        bytes: () => new Uint8Array(),
      },
      response: {} as never,
      services: registry,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: new AbortController().signal,
    } as never;
  }

  it('sets servicesContext and userContext when a principal is present', () => {
    const fakeUser = { id: '1', name: 'test-user' } as IPrincipal;
    const context = new FakeRouterContextProvider();

    applyDefaultLoadContext(buildCtx(fakeUser), context);

    expect(context.get(servicesContext)).toBe(registry);
    expect(context.get(userContext)).toBe(fakeUser);
  });

  it('leaves userContext at its null default on an anonymous request', () => {
    const context = new FakeRouterContextProvider();

    applyDefaultLoadContext(buildCtx(undefined), context);

    expect(context.get(servicesContext)).toBe(registry);
    // Resolves to the key's defaultValue rather than throwing.
    expect(context.get(userContext)).toBe(null);
  });

  it('context keys carry a null default so get() never throws for them', () => {
    // React Router's get() throws for an unset key with no defaultValue; both
    // exported keys must therefore declare one.
    expect(servicesContext.defaultValue).toBe(null);
    expect(userContext.defaultValue).toBe(null);
  });
});
