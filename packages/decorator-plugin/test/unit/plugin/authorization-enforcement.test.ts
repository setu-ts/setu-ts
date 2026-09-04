import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAuthorizationService,
  IPrincipal,
  IRequestContext,
  IServiceRegistry,
  IValidationService,
  MiddlewareFunction,
} from '@setu-ts/common';
import { securityMetadataOf } from '@setu-ts/common';

import {
  Controller,
  Get,
  Permissions,
  Post,
  Roles,
  UseFilters,
  UseGuards,
  UseInterceptors,
  ValidateBody,
} from '../../../src/index.ts';
import { DecoratorPlugin } from '../../../src/plugin/decorator-plugin.ts';
import {
  createPermissionsMiddleware,
  createRolesMiddleware,
} from '../../../src/plugin/authorization-middleware.ts';
import { metadataStore } from '../../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../../fixtures/fake-context.ts';

/**
 * X18-3: `@Roles`/`@Permissions` produced metadata nothing read — a `viewer`
 * reached an `@Roles('admin')` handler with `200` while
 * `@UseGuards(requireRole('admin'))` refused the same principal. These tests
 * drive the enforcing middleware the decorators now produce.
 */

/** A recording RBAC double honoring the committed `IAuthorizationService` shape. */
function fakeAuthorization(
  roles: readonly string[] = [],
  permissions: readonly string[] = [],
): IAuthorizationService {
  return {
    hasRole: (...args) => roles.includes(args[1]),
    hasPermission: (...args) => permissions.includes(args[1]),
    hasAnyRole: (principal, names) =>
      names.some((r) => fakeAuthorization(roles, permissions).hasRole(principal, r)),
    hasAllPermissions: (principal, names) =>
      names.every((p) => fakeAuthorization(roles, permissions).hasPermission(principal, p)),
  };
}

interface RecordedResponse {
  readonly statuses: number[];
  readonly bodies: Record<string, unknown>[];
}

/**
 * A minimal request context: principal from `options.user`, the authorization
 * capability from `options.authorization`, a response that records what a
 * short-circuit wrote (`respondWithError` writes through `status()` + `json()`
 * as two separate calls).
 */
function fakeRequestContext(options: {
  user?: IPrincipal;
  authorization?: IAuthorizationService;
}): { ctx: IRequestContext; response: RecordedResponse } {
  const statuses: number[] = [];
  const bodies: Record<string, unknown>[] = [];
  const response = {
    status: (code: number) => {
      statuses.push(code);
      return undefined;
    },
    json: (body: Record<string, unknown>) => {
      bodies.push(body);
      return undefined;
    },
  };
  const services: IServiceRegistry = {
    has: (token) => token === CAPABILITIES.AUTHORIZATION && options.authorization !== undefined,
    get: <T extends object>(token: string): T => {
      if (token === CAPABILITIES.AUTHORIZATION && options.authorization !== undefined) {
        return options.authorization as T;
      }
      throw new Error(`Service '${token}' not registered`);
    },
    register: () => {},
    registerFactory: () => {},
    getAll: () => [],
    unregister: () => false,
  };
  const ctx = {
    request: { ...(options.user !== undefined ? { user: options.user } : {}) },
    response,
    services,
    state: new Map<string, unknown>(),
  } as unknown as IRequestContext;
  return { ctx, response: { statuses, bodies } };
}

const next = () => Promise.resolve();

describe('authorization middleware refusals', () => {
  it("answers 401 with the guards' exact body when no principal is present", async () => {
    const middleware = createRolesMiddleware(['admin']);
    const { ctx, response } = fakeRequestContext({});

    await middleware(ctx, next);

    expect(response.statuses).toEqual([401]);
    expect(response.bodies).toEqual([
      { error: 'Unauthorized', detail: 'Authentication required' },
    ]);
  });

  it('answers 403 naming the single required role, byte-identical with requireRole', async () => {
    const middleware = createRolesMiddleware(['admin']);
    const { ctx, response } = fakeRequestContext({
      user: { id: 'u1', roles: ['viewer'] },
      authorization: fakeAuthorization(['viewer']),
    });

    await middleware(ctx, next);

    expect(response.statuses).toEqual([403]);
    expect(response.bodies).toEqual([
      { error: 'Forbidden', detail: 'Role "admin" is required' },
    ]);
  });

  it('answers 403 naming every role when several are declared', async () => {
    const middleware = createRolesMiddleware(['admin', 'owner']);
    const { ctx, response } = fakeRequestContext({
      user: { id: 'u1', roles: ['viewer'] },
      authorization: fakeAuthorization(['viewer']),
    });

    await middleware(ctx, next);

    expect(response.statuses).toEqual([403]);
    expect(response.bodies).toEqual([
      { error: 'Forbidden', detail: 'One of these roles is required: admin, owner' },
    ]);
  });

  it('admits a principal holding any one of the declared roles', async () => {
    let downstream = 0;
    const middleware = createRolesMiddleware(['admin', 'owner']);
    const { ctx, response } = fakeRequestContext({
      user: { id: 'u1', roles: ['owner'] },
      authorization: fakeAuthorization(['owner']),
    });

    await middleware(ctx, () => {
      downstream++;
      return Promise.resolve();
    });

    expect(downstream).toBe(1);
    expect(response.statuses).toEqual([]);
  });

  it('enforces @Permissions as ANY-of, composing the committed single check', async () => {
    // The principal holds the SECOND of the two declared permissions: some()
    // must admit it even though hasAllPermissions would refuse.
    const middleware = createPermissionsMiddleware(['billing:write', 'billing:admin']);
    const passing = fakeRequestContext({
      user: { id: 'u1', permissions: ['billing:admin'] },
      authorization: fakeAuthorization([], ['billing:admin']),
    });
    await middleware(passing.ctx, next);
    expect(passing.response.statuses).toEqual([]);

    const failing = fakeRequestContext({
      user: { id: 'u2', permissions: ['billing:read'] },
      authorization: fakeAuthorization([], ['billing:read']),
    });
    await middleware(failing.ctx, next);
    expect(failing.response.statuses).toEqual([403]);
    expect(failing.response.bodies).toEqual([
      {
        error: 'Forbidden',
        detail: 'One of these permissions is required: billing:write, billing:admin',
      },
    ]);
  });

  it('fails CLOSED with 501 when no authorization capability is registered', async () => {
    let downstream = 0;
    const middleware = createRolesMiddleware(['admin']);
    const { ctx, response } = fakeRequestContext({
      // A principal is present, so the refusal is the capability's absence —
      // not the 401.
      user: { id: 'u1', roles: ['admin'] },
    });

    await middleware(ctx, () => {
      downstream++;
      return Promise.resolve();
    });

    expect(downstream).toBe(0);
    expect(response.statuses).toEqual([501]);
    expect(response.bodies).toEqual([
      { error: 'Not Implemented', detail: 'Authorization is not configured' },
    ]);
  });

  it('brands every middleware with M57 security metadata so deriveSecurity sees it', () => {
    expect(securityMetadataOf(createRolesMiddleware(['admin']))?.authenticated).toBe(true);
    expect(securityMetadataOf(createPermissionsMiddleware(['p']))?.authenticated).toBe(true);
  });
});

interface MiddlewareCall {
  readonly schema: unknown;
  readonly target: 'body' | 'query' | 'params' | 'headers' | 'cookies';
}

/** A fake validation service whose middleware functions are uniquely marked. */
function fakeValidationService(): {
  service: IValidationService;
  calls: MiddlewareCall[];
  markerOf(fn: unknown): string | undefined;
} {
  const calls: MiddlewareCall[] = [];
  let n = 0;
  const service: IValidationService = {
    validate() {
      return { success: false, error: [] };
    },
    middleware(schema: unknown, target: MiddlewareCall['target']): MiddlewareFunction {
      calls.push({ schema, target });
      const fn: MiddlewareFunction = (...args) => args[1]();
      const marker = `mw-${++n}`;
      Object.defineProperty(fn, '__marker', { value: marker });
      return fn;
    },
  };
  return {
    service,
    calls,
    markerOf(fn: unknown): string | undefined {
      return (fn as { __marker?: string }).__marker;
    },
  };
}

/** Extracts the RouteDefinition a plugin registered (always a RouteDefinition). */
function asRouteDef(route: unknown): { middleware?: MiddlewareFunction[] } {
  return route as { middleware?: MiddlewareFunction[] };
}

/** True for the authorization middleware the plugin appends (M57-branded). */
function isAuthorizationMiddleware(fn: unknown): boolean {
  return securityMetadataOf(fn as MiddlewareFunction)?.authenticated === true;
}

describe('DecoratorPlugin authorization enforcement (X18-3)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('appends authorization after guards and before later route stages', async () => {
    const guardFn: MiddlewareFunction = () => {};
    const interceptorFn: MiddlewareFunction = () => {};
    const filterFn: MiddlewareFunction = () => {};
    const bodySchema = { kind: 'body-schema' };

    @Controller('/items')
    class ItemsController {
      @Post('/')
      @UseGuards(guardFn)
      @UseInterceptors(interceptorFn)
      @UseFilters(filterFn)
      @Roles('admin')
      @ValidateBody(bodySchema)
      create() {
        return null;
      }
    }

    const fake = fakeValidationService();
    const { ctx, routes } = createFakeContext();
    ctx.services.register(CAPABILITIES.VALIDATION, fake.service);
    ctx.services.register(CAPABILITIES.AUTHORIZATION, fakeAuthorization(['admin']));
    await DecoratorPlugin({ controllers: [ItemsController] }).register(ctx);

    const mw = asRouteDef(routes[0].route).middleware ?? [];
    // Order: guard, enforcement, then interceptors/filters and validation.
    // No later route stage can short-circuit an authorization declaration.
    expect(mw).toHaveLength(5);
    expect(mw[0]).toBe(guardFn);
    expect(isAuthorizationMiddleware(mw[1])).toBe(true);
    expect(mw[2]).toBe(interceptorFn);
    expect(mw[3]).toBe(filterFn);
    expect(mw.map((fn) => isAuthorizationMiddleware(fn))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(fake.calls).toEqual([{ schema: bodySchema, target: 'body' }]);
    expect(mw.map((fn) => fake.markerOf(fn))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'mw-1',
    ]);
  });

  it('appends roles THEN permissions for a route declaring both (ALL-of across kinds)', async () => {
    @Controller('/both')
    class BothController {
      @Get('/')
      @Roles('admin', 'owner')
      @Permissions('billing:write', 'billing:admin')
      list() {
        return [];
      }
    }

    const { ctx, routes } = createFakeContext();
    ctx.services.register(CAPABILITIES.AUTHORIZATION, fakeAuthorization(['admin']));
    await DecoratorPlugin({ controllers: [BothController] }).register(ctx);

    const mw = asRouteDef(routes[0].route).middleware ?? [];
    expect(mw.filter(isAuthorizationMiddleware)).toHaveLength(2);
  });

  it("method-level metadata overrides class-level (the decorators' documented precedence)", async () => {
    @Controller('/mixed')
    class MixedController {
      @Get('/admin-only')
      @Roles('admin')
      adminOnly() {
        return [];
      }

      @Get('/viewers')
      @Roles('viewer')
      viewers() {
        return [];
      }
    }

    const authorization = fakeAuthorization(['viewer']);
    const { ctx, routes } = createFakeContext();
    ctx.services.register(CAPABILITIES.AUTHORIZATION, authorization);
    await DecoratorPlugin({ controllers: [MixedController] }).register(ctx);

    // Route 0 keeps the class default ('admin'); route 1 overrides it with
    // 'viewer'. Proven against the RESOLVED capability: a viewer passes route
    // 1 and is refused by route 0 — the union would pass both.
    const admin = fakeRequestContext({
      user: { id: 'v', roles: ['viewer'] },
      authorization,
    });
    await (asRouteDef(routes[0].route).middleware as MiddlewareFunction[])[0](admin.ctx, next);
    expect(admin.response.statuses).toEqual([403]);

    const viewer = fakeRequestContext({
      user: { id: 'v', roles: ['viewer'] },
      authorization,
    });
    await (asRouteDef(routes[1].route).middleware as MiddlewareFunction[])[0](viewer.ctx, next);
    expect(viewer.response.statuses).toEqual([]);
  });

  it('appends nothing for a route without @Roles/@Permissions (including @Public)', async () => {
    @Controller('/plain')
    class PlainController {
      @Get('/')
      list() {
        return [];
      }
    }

    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [PlainController] }).register(ctx);

    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
  });
});
