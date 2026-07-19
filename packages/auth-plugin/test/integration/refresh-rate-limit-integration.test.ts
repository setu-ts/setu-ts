/**
 * Integration test for M16b: refresh-token rotation through the REGISTERED
 * plugin services, and rate limiting through a middleware chain.
 *
 * Exercises the full flow: register AuthPlugin, build a RefreshTokenService
 * from the RESOLVED IJwtService, run a login → refresh rotation round-trip,
 * authenticate the re-minted access token via authMiddleware (JwtStrategy),
 * revoke-then-refresh, and drive rateLimitMiddleware over a chain proving the
 * max+1-th request 429s without reaching the handler.
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import { rateLimitMiddleware } from '../../src/middleware/rate-limit-middleware.ts';
import { RefreshTokenService } from '../../src/services/refresh-token-service.ts';
import { MemoryRefreshTokenStore } from '../../src/stores/refresh-token-store.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HandlerResult,
  IJwtService,
  IPluginContext,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

type FakeRuntime = ReturnType<typeof createFakeRuntime>;

/** Register AuthPlugin against a minimal fake plugin context. */
function registerAuthPlugin(runtime: FakeRuntime): Map<string, unknown> {
  const registered = new Map<string, unknown>();

  const ctx = {
    services: {
      has: (token: string) => registered.has(token) || token === 'runtime',
      get: <T>(token: string): T => {
        if (token === 'runtime') {
          return runtime as T;
        }
        return registered.get(token) as T;
      },
      getAll: <T>(_token: string): readonly T[] => [],
      register: (token: string, svc: unknown) => {
        registered.set(token, svc);
      },
      registerFactory: () => {},
      unregister: () => false,
    },
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    environment: { validate: () => {} },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    lifecycle: {
      onClose: () => {},
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
    },
    runtime,
    options: {},
    app: null,
  } as unknown as IPluginContext;

  AuthPlugin({
    jwt: { secret: 'integration-secret' },
    rbac: { roles: { admin: { permissions: ['*'] } } },
  }).register(ctx);
  return registered;
}

/** Build a request context wired to the registered services. */
function createRequestContext(
  registered: Map<string, unknown>,
  runtime: FakeRuntime,
  options?: { authToken?: string; ip?: string },
): { ctx: IRequestContext; captured: { status: number; headers: Headers } } {
  const headers = new Headers();
  if (options?.authToken !== undefined) {
    headers.set('authorization', `Bearer ${options.authToken}`);
  }

  const request: IRequest & { user?: IPrincipal } = {
    method: 'GET',
    url: '/',
    path: '/',
    headers,
    ...(options?.ip !== undefined ? { ip: options.ip } : {}),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };

  const captured = { status: 200, headers: new Headers() };
  const response: IResponse = {
    status: (code: number) => {
      captured.status = code;
      return response;
    },
    header: (name: string, value: string) => {
      captured.headers.set(name, value);
      return response;
    },
    appendHeader: () => response,
    json: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    text: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    send: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    redirect: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    snapshot: () => ({ status: captured.status, headers: captured.headers, body: null }),
  };

  const services = {
    get: <T>(token: string): T => {
      if (token === CAPABILITIES.RUNTIME) {
        return runtime as T;
      }
      if (registered.has(token)) {
        return registered.get(token) as T;
      }
      throw new Error(`unexpected token: ${token}`);
    },
    has: (token: string) => registered.has(token) || token === CAPABILITIES.RUNTIME,
    register: () => {},
  } as unknown as IServiceRegistry;

  const ctx: IRequestContext = {
    id: 'integration-test',
    request,
    response,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
  };

  return { ctx, captured };
}

describe('M16b integration — refresh rotation + rate limiting', () => {
  let runtime: FakeRuntime;
  let registered: Map<string, unknown>;
  let jwt: IJwtService;

  beforeAll(() => {
    runtime = createFakeRuntime();
    registered = registerAuthPlugin(runtime);
    jwt = registered.get(CAPABILITIES.JWT) as IJwtService;
  });

  it('login → refresh rotation round-trip; the re-minted access token authenticates', async () => {
    const store = new MemoryRefreshTokenStore(runtime);
    const service = new RefreshTokenService({ jwt, store, runtime });
    const principal: IPrincipal = { id: 'user-42', roles: ['admin'] };

    // Login: issue the initial pair
    const pair1 = await service.issue(principal);
    expect(pair1.accessToken).toBeDefined();
    expect(pair1.refreshToken).toBeDefined();

    // Refresh: rotate to a new pair
    const pair2 = await service.refresh(pair1.refreshToken);
    expect(pair2).not.toBeNull();

    // Replaying the rotated (old) refresh token is rejected
    expect(await service.refresh(pair1.refreshToken)).toBeNull();

    // The re-minted access token authenticates through the REGISTERED
    // strategy chain: authMiddleware → IAuthService → JwtStrategy
    const { ctx } = createRequestContext(registered, runtime, {
      authToken: pair2!.accessToken,
    });
    await authMiddleware()(ctx, () => Promise.resolve());

    expect(ctx.request.user?.id).toBe('user-42');
    expect(ctx.request.user?.roles).toEqual(['admin']);
  });

  it('revoke (logout) then refresh fails', async () => {
    const store = new MemoryRefreshTokenStore(runtime);
    const service = new RefreshTokenService({ jwt, store, runtime });

    const pair = await service.issue({ id: 'user-42' });

    expect(await service.revoke(pair.refreshToken)).toBe(true);
    expect(await service.refresh(pair.refreshToken)).toBeNull();
  });

  it('rate limiting: max requests pass, the max+1-th 429s without reaching the handler', async () => {
    const middleware = rateLimitMiddleware({ windowMs: 60000, max: 3 });
    let handlerReached = 0;
    const handler = () => {
      handlerReached++;
      return Promise.resolve();
    };

    for (let i = 0; i < 3; i++) {
      const { ctx, captured } = createRequestContext(registered, runtime, { ip: '10.0.0.1' });
      await middleware(ctx, handler);
      expect(captured.status).toBe(200);
    }
    expect(handlerReached).toBe(3);

    const { ctx, captured } = createRequestContext(registered, runtime, { ip: '10.0.0.1' });
    await middleware(ctx, handler);

    expect(captured.status).toBe(429);
    expect(captured.headers.get('Retry-After')).toBeDefined();
    expect(handlerReached).toBe(3); // handler NOT reached on the 429
  });
});
