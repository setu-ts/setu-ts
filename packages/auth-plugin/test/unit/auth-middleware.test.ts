/**
 * Tests for auth middleware.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import type {
  HandlerResult,
  IAuthService,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';

function createContext(authService: IAuthService): {
  ctx: IRequestContext;
  request: { user?: IPrincipal };
} {
  const request: IRequest & { user?: IPrincipal } = {
    method: 'GET',
    url: '/',
    path: '/',
    headers: new Headers(),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };

  const response: IResponse = {
    status: () => response,
    header: () => response,
    appendHeader: () => response,
    json: (): HandlerResult => ({ __handlerResult: true }),
    text: (): HandlerResult => ({ __handlerResult: true }),
    send: (): HandlerResult => ({ __handlerResult: true }),
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ status: 200, headers: new Headers(), body: null }),
  };

  const services = {
    get: <T>(token: string): T => {
      if (token === 'authentication') {
        return authService as T;
      }
      throw new Error(`unexpected token: ${token}`);
    },
    has: () => true,
    register: () => {},
  } as unknown as IServiceRegistry;

  const ctx: IRequestContext = {
    id: 'test',
    request,
    response,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
  };

  return { ctx, request };
}

describe('authMiddleware', () => {
  it('sets ctx.request.user when authenticate returns a principal', async () => {
    const principal: IPrincipal = { id: 'user1', roles: ['user'] };
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: async () => principal,
      verifyCredentials: async () => null,
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(request.user).toEqual(principal);
    expect(nextCalled).toBe(true);
  });

  it('does not set user when authenticate returns null', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: async () => null,
      verifyCredentials: async () => null,
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(request.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('always calls next (no short-circuit) even when no principal', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: async () => null,
      verifyCredentials: async () => null,
    };
    const { ctx } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('always calls next when a principal is found', async () => {
    const middleware = authMiddleware();
    const principal: IPrincipal = { id: 'user1' };
    const authService: IAuthService = {
      authenticate: async () => principal,
      verifyCredentials: async () => null,
    };
    const { ctx } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('continues (calls next) when authenticate throws', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: async () => {
        throw new Error('auth service down');
      },
      verifyCredentials: async () => null,
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(request.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});
