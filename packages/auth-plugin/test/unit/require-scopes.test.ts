/**
 * `requireScopes`: build-time validation, ALL-of enforcement, the required-scope
 * state entry, the security brand, and short-circuiting a refused request.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { HandlerResult, IPrincipal, IRequestContext, IResponse } from '@setu-ts/common';
import { securityMetadataOf } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../../src/errors.ts';
import { requireScopes } from '../../src/guards/index.ts';
import { REQUIRED_SCOPES_STATE_KEY } from '@setu-ts/common';

function createContext(user?: IPrincipal): {
  ctx: IRequestContext;
  state: Map<string, unknown>;
  status: () => number;
} {
  let statusCode = 200;
  const response: IResponse = {
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    setHeaders: () => response,
    header: () => response,
    appendHeader: () => response,
    json: <T>(_body: T): HandlerResult => ({ __handlerResult: true }),
    text: (_body: string): HandlerResult => ({ __handlerResult: true }),
    html: (_body: string): HandlerResult => ({ __handlerResult: true }),
    send: (_body?: Uint8Array): HandlerResult => ({ __handlerResult: true }),
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    stream: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ streaming: false, status: statusCode, headers: new Headers(), body: null }),
  };
  const request = {
    method: 'GET',
    url: '/',
    path: '/',
    headers: new Headers(),
    ...(user === undefined ? {} : { user }),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
  const state = new Map<string, unknown>();
  return {
    ctx: {
      id: 'test',
      request: request as unknown as IRequestContext['request'],
      response,
      services: {} as unknown as IRequestContext['services'],
      params: {},
      query: {},
      state,
      startTime: 0,
      signal: new AbortController().signal,
    },
    state,
    status: () => statusCode,
  };
}

function createNext(): { next: () => Promise<void>; calls: number } {
  const tracker: { next: () => Promise<void>; calls: number } = {
    calls: 0,
    next: () => {
      tracker.calls += 1;
      return Promise.resolve();
    },
  };
  return tracker;
}

describe('requireScopes build-time validation', () => {
  it('refuses a value that is not an RFC 6749 scope token', () => {
    for (const scope of ['', 'a b', 'a"b', 'a\\b', 'café']) {
      expect(() => requireScopes(scope)).toThrow(AuthPluginConfigurationError);
    }
  });

  it('refuses the same scope twice', () => {
    expect(() => requireScopes('tools:read', 'tools:write', 'tools:read')).toThrow(
      /more than once/,
    );
  });
});

describe('requireScopes', () => {
  it('answers 401 and does not continue when anonymous', async () => {
    const guard = requireScopes('tools:read');
    const { ctx, status } = createContext();
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(status()).toBe(401);
    expect(nt.calls).toBe(0);
  });

  it('continues when the principal holds every required scope', async () => {
    const guard = requireScopes('tools:read', 'tools:list');
    const { ctx } = createContext({ id: 'u1', scopes: ['tools:list', 'tools:read', 'other'] });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(nt.calls).toBe(1);
  });

  it('answers 403 with the required list when one of two is missing', async () => {
    const guard = requireScopes('tools:read', 'tools:list');
    const { ctx, status, state } = createContext({ id: 'u1', scopes: ['tools:read'] });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(status()).toBe(403);
    expect(state.get(REQUIRED_SCOPES_STATE_KEY)).toEqual(['tools:read', 'tools:list']);
    expect(nt.calls).toBe(0);
  });

  it('treats an absent scopes member as holding none', async () => {
    const guard = requireScopes('tools:read');
    const { ctx, status } = createContext({ id: 'u1' });
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(status()).toBe(403);
    expect(nt.calls).toBe(0);
  });

  it('treats a non-array scopes member as holding none, never a substring match', async () => {
    const guard = requireScopes('tools:read', 'tools:write');
    // A mapper that copied the raw claim string; `includes` would match substrings.
    const raw = { id: 'u1', scopes: 'xtools:readx xtools:writex' } as unknown as IPrincipal;
    const { ctx, status } = createContext(raw);
    const nt = createNext();
    await guard(ctx, nt.next);
    expect(status()).toBe(403);
    expect(nt.calls).toBe(0);
  });

  it('does not run downstream work on a refusal', async () => {
    const guard = requireScopes('tools:read');
    const { ctx } = createContext({ id: 'u1', scopes: [] });
    let handlerRan = false;
    await guard(ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });
    expect(handlerRan).toBe(false);
  });

  it('brands the guard with the required scopes for documentation', () => {
    const guard = requireScopes('tools:read', 'tools:list');
    expect(securityMetadataOf(guard)).toEqual({
      authenticated: true,
      scopes: ['tools:read', 'tools:list'],
      forbids: true,
    });
  });
});
