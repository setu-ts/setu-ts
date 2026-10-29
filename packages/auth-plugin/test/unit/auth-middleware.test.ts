/**
 * Tests for auth middleware.
 */

import { describe, expect, it } from 'vitest';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import { AuthService, LocalStrategy } from '../../src/services/auth-service.ts';
import { CREDENTIAL_SOURCE_STATE_KEY, sealRequestIdentity } from '@setu-ts/common';
import type {
  HandlerResult,
  IAuthStrategy,
  IAuthService,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@setu-ts/common';

/** An `AuthService` whose chain matches with the given credential source. */
function serviceWithSource(credential: 'header' | 'cookie'): AuthService {
  const strategy: IAuthStrategy = {
    name: 's1',
    credential,
    authenticate: () => Promise.resolve({ id: 'u' }),
  };
  return new AuthService([strategy], new LocalStrategy(() => Promise.resolve(null)));
}

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

  const _abortController = new AbortController();

  const response: IResponse = {
    status: () => response,
    setHeaders: () => response,
    header: () => response,
    appendHeader: () => response,
    json: (): HandlerResult => ({ __handlerResult: true }),
    text: (): HandlerResult => ({ __handlerResult: true }),
    html: (): HandlerResult => ({ __handlerResult: true }),
    send: (): HandlerResult => ({ __handlerResult: true }),
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    stream: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
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
    signal: _abortController.signal,
  };

  return { ctx, request };
}

describe('authMiddleware', () => {
  it('sets ctx.request.user when authenticate returns a principal', async () => {
    const principal: IPrincipal = { id: 'user1', roles: ['user'] };
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: () => Promise.resolve(principal),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(request.user).toEqual(principal);
    expect(nextCalled).toBe(true);
  });

  it('can run twice over a sealed request through the deliberate replacement escape', async () => {
    const principals: IPrincipal[] = [
      { id: 'first', roles: [] },
      { id: 'second', roles: [] },
    ];
    let index = 0;
    const authService: IAuthService = {
      authenticate: (): Promise<IPrincipal> => Promise.resolve(principals[index++]),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx, request } = createContext(authService);
    sealRequestIdentity(ctx.request);
    const middleware = authMiddleware();
    await middleware(ctx, () => Promise.resolve());
    await middleware(ctx, () => Promise.resolve());
    expect(request.user).toBe(principals[1]);
  });

  it('does not set user when authenticate returns null', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: () => Promise.resolve(null),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(request.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('always calls next (no short-circuit) even when no principal', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: () => Promise.resolve(null),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
  });

  it('always calls next when a principal is found', async () => {
    const middleware = authMiddleware();
    const principal: IPrincipal = { id: 'user1' };
    const authService: IAuthService = {
      authenticate: () => Promise.resolve(principal),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
  });

  it('continues (calls next) when authenticate throws', async () => {
    const middleware = authMiddleware();
    const authService: IAuthService = {
      authenticate: () => Promise.reject(new Error('auth service down')),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx, request } = createContext(authService);

    let nextCalled = false;
    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(request.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('records the header source under CREDENTIAL_SOURCE_STATE_KEY when a header strategy authenticated', async () => {
    const principal: IPrincipal = { id: 'header-user' };
    const service = new AuthService(
      [{ name: 'jwt', credential: 'header', authenticate: () => Promise.resolve(principal) }],
      new LocalStrategy(() => Promise.resolve(null)),
    );
    const { ctx, request } = createContext(service);

    await authMiddleware()(ctx, () => Promise.resolve());

    expect(ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY)).toBe('header');
    expect(request.user).toBe(principal);
  });

  it('records the cookie source under CREDENTIAL_SOURCE_STATE_KEY when a session strategy authenticated', async () => {
    const { ctx } = createContext(serviceWithSource('cookie'));

    await authMiddleware()(ctx, () => Promise.resolve());

    expect(ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY)).toBe('cookie');
  });

  it('sets no source when nothing authenticated, so form CSRF stays closed', async () => {
    const service = new AuthService(
      [{ name: 'jwt', credential: 'header', authenticate: () => Promise.resolve(null) }],
      new LocalStrategy(() => Promise.resolve(null)),
    );
    const { ctx, request } = createContext(service);

    await authMiddleware()(ctx, () => Promise.resolve());

    expect(ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY)).toBeUndefined();
    expect(request.user).toBeUndefined();
  });

  it('keeps working through authenticate, recording no source, with a replaced service lacking the method', async () => {
    const principal: IPrincipal = { id: 'replaced' };
    const service: IAuthService = {
      authenticate: () => Promise.resolve(principal),
      verifyCredentials: () => Promise.resolve(null),
    };
    const { ctx, request } = createContext(service);

    let nextCalled = false;
    await authMiddleware()(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(request.user).toBe(principal);
    expect(ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY)).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});
