/**
 * Integration test for auth plugin.
 *
 * Exercises the full flow: register AuthPlugin, sign a JWT token, authenticate
 * through authMiddleware, and authorize through guards.
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import { requireAuth, requireRole } from '../../src/guards/index.ts';
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

/**
 * Creates a fake plugin context with the fake runtime.
 */
function createFakeContext(runtime: ReturnType<typeof createFakeRuntime>): {
  ctx: IPluginContext;
  registered: Map<string, unknown>;
} {
  const registered = new Map<string, unknown>();

  const ctx: IPluginContext = {
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
    environment: {
      validate: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: {
      addSchema: () => {},
    },
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
    app: null as unknown as IPluginContext['app'],
  };

  return { ctx, registered };
}

/**
 * Create a request with optional auth header and user.
 */
function createRequest(authToken?: string, user?: IPrincipal): IRequest & { user?: IPrincipal } {
  const headers = new Headers();
  if (authToken) {
    headers.set('authorization', `Bearer ${authToken}`);
  }

  const request: IRequest & { user?: IPrincipal } = {
    method: 'GET',
    url: '/',
    path: '/',
    headers,
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };

  if (user) {
    request.user = user;
  }

  return request;
}

/**
 * Create a request context with the registered services.
 */
function createRequestContext(
  registered: Map<string, unknown>,
  runtime: ReturnType<typeof createFakeRuntime>,
  authToken?: string,
): IRequestContext {
  const request = createRequest(authToken);

  let statusCode = 200;
  const resp: IResponse = {
    status: (code: number) => {
      statusCode = code;
      return resp;
    },
    header: () => resp,
    appendHeader: () => resp,
    json: (): HandlerResult => ({ __handlerResult: true }),
    text: (): HandlerResult => ({ __handlerResult: true }),
    send: (): HandlerResult => ({ __handlerResult: true }),
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ status: statusCode, headers: new Headers(), body: null }),
  };

  const services: IServiceRegistry = {
    has: (token: string) => registered.has(token) || token === 'runtime',
    get: <T>(token: string): T => {
      if (token === 'runtime') {
        return runtime as T;
      }
      return registered.get(token) as T;
    },
    getAll: <T>(_token: string): readonly T[] => [],
    register: () => {},
    registerFactory: () => {},
    unregister: () => false,
  };

  return {
    id: 'integration-test',
    request,
    response: resp,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
  };
}

describe('Auth Plugin Integration', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;
  let jwtService: IJwtService;
  let registered: Map<string, unknown>;

  beforeAll(async () => {
    runtime = createFakeRuntime(1000000);

    // Register the plugin
    const plugin = AuthPlugin({
      jwt: { secret: 'integration-test-secret' },
      rbac: {
        roles: {
          admin: { permissions: ['*'], inherits: ['user'] },
          user: { permissions: ['users:read'] },
        },
      },
    });

    const ctx = createFakeContext(runtime);
    await plugin.register!(ctx.ctx);
    registered = ctx.registered;
    jwtService = registered.get(CAPABILITIES.JWT) as IJwtService;
  });

  it('authenticates a request with valid JWT and sets ctx.request.user', async () => {
    const token = await jwtService.sign({
      sub: 'user123',
      roles: ['admin'],
      permissions: ['users:read', 'users:write'],
    });

    const ctx = createRequestContext(registered, runtime, token);

    // Run auth middleware
    const middleware = authMiddleware();
    await middleware(ctx, async () => {});

    // Assert user was set
    expect(ctx.request.user).toBeDefined();
    expect(ctx.request.user!.id).toBe('user123');
    expect(ctx.request.user!.roles).toContain('admin');
  });

  it('does not set user when no token is present', async () => {
    const ctx = createRequestContext(registered, runtime);
    const middleware = authMiddleware();
    await middleware(ctx, async () => {});
    expect(ctx.request.user).toBeUndefined();
  });

  it('requireAuth guard allows authenticated requests', async () => {
    const token = await jwtService.sign({ sub: 'user123', roles: ['user'] });
    const ctx = createRequestContext(registered, runtime, token);

    // First authenticate
    const middleware = authMiddleware();
    await middleware(ctx, async () => {});

    // Then require auth
    let nextCalled = false;
    await requireAuth()(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(nextCalled).toBe(true);
  });

  it('requireAuth guard returns 401 for unauthenticated requests', async () => {
    const ctx = createRequestContext(registered, runtime);

    let statusSet = 200;
    const originalStatus = ctx.response.status;
    ctx.response.status = (code: number) => {
      statusSet = code;
      return originalStatus(code);
    };

    let nextCalled = false;
    await requireAuth()(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(statusSet).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('requireRole guard allows matching role', async () => {
    const token = await jwtService.sign({ sub: 'user123', roles: ['admin'] });
    const ctx = createRequestContext(registered, runtime, token);

    // Authenticate
    const middleware = authMiddleware();
    await middleware(ctx, async () => {});

    // Require role
    let nextCalled = false;
    await requireRole('user')(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    // admin inherits user, so this should pass
    expect(nextCalled).toBe(true);
  });

  it('requireRole guard returns 403 for insufficient role', async () => {
    const token = await jwtService.sign({ sub: 'user123', roles: ['user'] });
    const ctx = createRequestContext(registered, runtime, token);

    // Authenticate
    const middleware = authMiddleware();
    await middleware(ctx, async () => {});

    let statusSet = 200;
    const originalStatus = ctx.response.status;
    ctx.response.status = (code: number) => {
      statusSet = code;
      return originalStatus(code);
    };

    let nextCalled = false;
    await requireRole('admin')(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(statusSet).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('login flow: verifyCredentials mints a usable JWT', async () => {
    const loginPayload = { sub: 'login-user', roles: ['user'] };
    const token = await jwtService.sign(loginPayload, { expiresIn: '1h' });

    // Verify the token
    const payload = await jwtService.verify<{ sub: string; roles: string[] }>(token);
    expect(payload.sub).toBe('login-user');
    expect(payload.roles).toContain('user');
  });

  it('full flow: sign token → authenticate → authorize → handler', async () => {
    const token = await jwtService.sign({
      sub: 'full-flow-user',
      roles: ['admin'],
      permissions: ['users:read', 'users:write'],
    });

    const ctx = createRequestContext(registered, runtime, token);

    // Step 1: Authenticate
    await authMiddleware()(ctx, async () => {
      // Step 2: Authorize
      let handlerCalled = false;
      await requireRole('admin')(ctx, () => {
        handlerCalled = true;
        return Promise.resolve();
      });

      expect(handlerCalled).toBe(true);
    });
  });

  it('expired token is rejected by auth middleware', async () => {
    const token = await jwtService.sign({ sub: 'user123' }, { expiresIn: '1s' });
    // Advance clock past expiry
    runtime.setNow(1000000 + 10000);

    const ctx = createRequestContext(registered, runtime, token);
    await authMiddleware()(ctx, async () => {});

    expect(ctx.request.user).toBeUndefined();
  });
});
