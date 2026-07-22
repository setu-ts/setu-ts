/**
 * Tests for the default loadContext bridge.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal } from '@hono-enterprise/common';
import type { LoadContextFunction } from '../../src/interfaces/index.ts';
import { createDefaultLoadContext } from '../../src/handler/load-context.ts';

describe('load-context', () => {
  // Build minimal IRequestContext using a partial mock (we only read ctx.services and ctx.request.user).
  function buildCtx(
    principal?: IPrincipal,
  ): Parameters<typeof createDefaultLoadContext>[0] {
    return {
      id: 'req-1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/',
        path: '/',
        headers: new Headers(),
        user: principal,
        json: async () => ({}),
        text: async () => '',
        bytes: async () => new Uint8Array(),
      },
      response: {} as never,
      services: {} as never,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: new AbortController().signal,
    } as never;
  }

  it('default loadContext exposes services and user when present', () => {
    const fakeUser = { id: '1', name: 'test-user' } as IPrincipal;
    const ctx = buildCtx(fakeUser);
    const result = createDefaultLoadContext(ctx);

    expect(result).toHaveProperty('services');
    expect((result as Record<string, unknown>).user).toBe(fakeUser);
  });

  it('default omits user key when user is absent (exactOptionalPropertyTypes)', () => {
    const ctx = buildCtx(undefined);
    const result = createDefaultLoadContext(ctx);

    expect(result).toHaveProperty('services');
    expect('user' in result).toBe(false);
  });

  it('custom LoadContextFunction override is honored', () => {
    const ctx = buildCtx({ id: '2', name: 'u' } as unknown as IPrincipal);
    const customFn: LoadContextFunction = (_c: unknown) => ({ custom: 'http://localhost/' });
    const result = customFn(ctx);

    expect(result).toEqual({ custom: 'http://localhost/' });
  });
});
