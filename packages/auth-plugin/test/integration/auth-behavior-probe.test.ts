/**
 * Production-default behavioral probe for the auth plugin (M16).
 *
 * One end-to-end probe exercising the real code paths with the production
 * defaults (HS256, PBKDF2-SHA256) and the real Web Crypto exposed by the fake
 * runtime:
 *   1. sign + verify an HS256 JWT;
 *   2. run the passive strategy chain via `authMiddleware` to populate
 *      `ctx.request.user`;
 *   3. resolve RBAC role-hierarchy permissions (admin satisfies 'user' via
 *      `inherits`);
 *   4. hash + verify a password with PBKDF2;
 *   5. confirm `requireAuth` short-circuits 401 (downstream handler NOT run);
 *   6. confirm `requireRole` short-circuits 403 (downstream handler NOT run).
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import { requireAuth, requireRole } from '../../src/guards/index.ts';
import { PasswordHasher } from '../../src/services/password-hasher.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HandlerResult,
  IAuthorizationService,
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

interface ProbeContext {
  ctx: IRequestContext;
  getStatus(): number;
}

/**
 * Build a request context backed by the registered services, exposing the
 * response status so guard short-circuits can be asserted.
 */
function createProbeRequestContext(
  registered: Map<string, unknown>,
  runtime: ReturnType<typeof createFakeRuntime>,
  authToken?: string,
): ProbeContext {
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

  const ctx: IRequestContext = {
    id: 'behavior-probe',
    request,
    response: resp,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
  };

  return { ctx, getStatus: () => statusCode };
}

describe('Auth Plugin behavioral probe', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;
  let jwtService: IJwtService;
  let authzService: IAuthorizationService;
  let registered: Map<string, unknown>;

  beforeAll(async () => {
    runtime = createFakeRuntime(1_700_000_000_000);

    const plugin = AuthPlugin({
      jwt: { secret: 'probe-hs256-secret' },
      rbac: {
        roles: {
          admin: { permissions: ['*'], inherits: ['user'] },
          user: { permissions: ['users:read'] },
        },
      },
    });

    const fakeCtx = createFakeContext(runtime);
    await plugin.register!(fakeCtx.ctx);
    registered = fakeCtx.registered;
    jwtService = registered.get(CAPABILITIES.JWT) as IJwtService;
    authzService = registered.get(CAPABILITIES.AUTHORIZATION) as IAuthorizationService;
  });

  it('exercises sign/verify, strategy chain, RBAC hierarchy, password hashing, and guard short-circuits', async () => {
    // 1) Sign + verify an HS256 JWT.
    const token = await jwtService.sign(
      { sub: 'probe-admin', roles: ['admin'] },
      { expiresIn: '1h' },
    );
    const payload = await jwtService.verify<{ sub: string; roles: string[] }>(token);
    expect(payload.sub).toBe('probe-admin');
    expect(payload.roles).toContain('admin');

    // 2) Run the passive strategy chain via authMiddleware to populate a principal.
    const authed = createProbeRequestContext(registered, runtime, token);
    let mwNext = 0;
    await authMiddleware()(authed.ctx, () => {
      mwNext++;
      return Promise.resolve();
    });
    expect(mwNext).toBe(1); // authMiddleware never short-circuits
    expect(authed.ctx.request.user).toBeDefined();
    const principal = authed.ctx.request.user!;
    expect(principal.id).toBe('probe-admin');

    // 3) RBAC role-hierarchy: admin satisfies 'user' via the inherited role.
    expect(authzService.hasRole(principal, 'user')).toBe(true);
    const roleGuard = createProbeRequestContext(registered, runtime, token);
    await authMiddleware()(roleGuard.ctx, () => Promise.resolve());
    let roleNext = 0;
    await requireRole('user')(roleGuard.ctx, () => {
      roleNext++;
      return Promise.resolve();
    });
    expect(roleNext).toBe(1); // admin inherits user -> guard passes
    expect(roleGuard.getStatus()).toBe(200);

    // 4) PBKDF2-SHA256 password hash + verify (real Web Crypto).
    const hasher = new PasswordHasher(runtime);
    const stored = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(stored, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(stored, 'wrong secret')).toBe(false);

    // 5) requireAuth short-circuits 401 when unauthenticated (downstream NOT invoked).
    const unauthed = createProbeRequestContext(registered, runtime); // no bearer token
    let unauthNext = 0;
    await requireAuth()(unauthed.ctx, () => {
      unauthNext++;
      return Promise.resolve();
    });
    expect(unauthed.getStatus()).toBe(401);
    expect(unauthNext).toBe(0); // short-circuit: handler never ran

    // 6) requireRole short-circuits 403 when the principal lacks the role.
    const limitedToken = await jwtService.sign({ sub: 'plain-user', roles: ['user'] });
    const limited = createProbeRequestContext(registered, runtime, limitedToken);
    await authMiddleware()(limited.ctx, () => Promise.resolve());
    let limitedNext = 0;
    await requireRole('admin')(limited.ctx, () => {
      limitedNext++;
      return Promise.resolve();
    });
    expect(limited.getStatus()).toBe(403);
    expect(limitedNext).toBe(0); // short-circuit: handler never ran
  });
});
