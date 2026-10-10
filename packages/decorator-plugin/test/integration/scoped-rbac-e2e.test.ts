/**
 * `@ScopedRoles` / `@ScopedPermissions` through a REAL kernel application
 * (M110b plan §3.15): any-of and all-of, class defaults overridden per method,
 * the band order after `@Roles`, the `@Public` marker omitted, every
 * register-time refusal, and byte-identical refusal bodies against AuthPlugin's
 * `requireScopedPermission` under `errorHandler({ format: 'rfc9457' })`.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { scopeFromParam } from '@setu-ts/common';
import type { IAuthStrategy, IPrincipal, ScopedGrant } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { AuthPlugin, requireScopedPermission } from '@setu-ts/auth-plugin';
import type { AuthPluginOptions } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import {
  Controller,
  Get,
  Post,
  Public,
  Roles,
  ScopedPermissions,
  ScopedRoles,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import type { Constructor } from '@setu-ts/common';

const RBAC = {
  roles: {
    viewer: { permissions: ['invoices:read'] },
    approver: { permissions: ['invoices:approve'], inherits: ['viewer'] },
    admin: { permissions: ['*'] },
  },
} as const;

/** `x-user` / `x-roles` → principal. */
const headers: IAuthStrategy = {
  name: 'test-headers',
  authenticate(request): Promise<IPrincipal | null> {
    const id = request.headers.get('x-user');
    if (id === null) {
      return Promise.resolve(null);
    }
    const roles = request.headers.get('x-roles');
    return Promise.resolve(roles === null ? { id } : { id, roles: roles.split(',') });
  },
};

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop().catch(() => {});
  app = undefined;
});

const TENANT = (id: string) => ({ type: 'tenant', id });

/** Counts source calls, so the band order is observable. */
const calls: string[] = [];

const GRANTS: Record<string, readonly ScopedGrant[]> = {
  ann: [{ role: 'approver', scope: TENANT('acme') }],
  vic: [{ role: 'viewer', scope: TENANT('acme') }],
  org: [{ role: 'viewer', scope: { type: 'organisation', id: 'o1' } }],
};

const scopedRbac: NonNullable<AuthPluginOptions['scopedRbac']> = {
  sources: [{
    kind: 'custom',
    source: {
      name: 'test',
      grantsFor: (principal) => {
        calls.push(principal.id);
        return Promise.resolve(GRANTS[principal.id] ?? []);
      },
    },
  }],
};

@Controller('/c')
@ScopedRoles(['viewer'])
class InvoiceController {
  @Get('/read')
  read() {
    return { ok: 'read' };
  }

  @Post('/approve')
  @ScopedPermissions(['invoices:read', 'invoices:approve'])
  approve() {
    return { ok: 'approve' };
  }

  @Post('/any')
  @ScopedRoles(['approver', 'admin'])
  any() {
    return { ok: 'any' };
  }

  @Get('/org/:orgId')
  @ScopedRoles(['viewer'], scopeFromParam('orgId', 'organisation'))
  org() {
    return { ok: 'org' };
  }

  @Post('/guarded')
  @Roles('admin')
  @ScopedRoles(['approver'])
  guarded() {
    return { ok: 'guarded' };
  }

  @Get('/open')
  @Public()
  open() {
    return { ok: 'open' };
  }
}

async function start(
  controllers: readonly Constructor[] = [InvoiceController],
  auth: Partial<AuthPluginOptions> | null = { scopedRbac },
): Promise<IKernelApplication> {
  calls.length = 0;
  const built = createApplication({
    plugins: [
      RuntimePlugin(),
      MultiTenancyPlugin({ resolver: 'header' }),
      ...(auth === null ? [] : [AuthPlugin({ rbac: RBAC, ...auth, strategies: [headers] })]),
      DecoratorPlugin({ controllers: [...controllers] }),
    ],
  });
  built.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 50 });
  built.router.post('/g/approve', {
    middleware: [requireScopedPermission(['invoices:read', 'invoices:approve'])],
    handler: (ctx) => ctx.response.json({ ok: 'guard' }),
  });
  await built.start();
  app = built;
  return built;
}

async function hit(
  path: string,
  init: { method?: string; user?: string; tenant?: string; roles?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headersInit: Record<string, string> = {};
  if (init.user !== undefined) headersInit['x-user'] = init.user;
  if (init.tenant !== undefined) headersInit['x-tenant-id'] = init.tenant;
  if (init.roles !== undefined) headersInit['x-roles'] = init.roles;
  const response = await app!.fetch(
    new Request(`http://localhost${path}`, { method: init.method ?? 'GET', headers: headersInit }),
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

describe('@ScopedRoles / @ScopedPermissions — enforcement', () => {
  it('a class-level @ScopedRoles applies to every route', async () => {
    await start();
    expect((await hit('/c/read', { user: 'vic', tenant: 'acme' })).status).toBe(200);
    expect((await hit('/c/read', { user: 'vic', tenant: 'globex' })).status).toBe(403);
  });

  it('@ScopedPermissions is all-of', async () => {
    await start();
    expect((await hit('/c/approve', { method: 'POST', user: 'ann', tenant: 'acme' })).status).toBe(
      200,
    );
    expect((await hit('/c/approve', { method: 'POST', user: 'vic', tenant: 'acme' })).status).toBe(
      403,
    );
  });

  it('a method @ScopedRoles overrides the class default and is any-of', async () => {
    await start();
    expect((await hit('/c/any', { method: 'POST', user: 'ann', tenant: 'acme' })).status).toBe(200);
    // vic satisfies the class default (viewer) but the method requires approver/admin.
    expect((await hit('/c/any', { method: 'POST', user: 'vic', tenant: 'acme' })).status).toBe(403);
  });

  it('honours a route-parameter scope', async () => {
    await start();
    expect((await hit('/c/org/o1', { user: 'org' })).status).toBe(200);
    expect((await hit('/c/org/o2', { user: 'org' })).status).toBe(403);
  });

  it('refuses an anonymous request 401 before any grant source is asked', async () => {
    await start();
    expect((await hit('/c/read', { tenant: 'acme' })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('runs after @Roles: a @Roles refusal never reaches the grant source', async () => {
    await start();
    expect((await hit('/c/guarded', { method: 'POST', user: 'ann', tenant: 'acme' })).status).toBe(
      403,
    );
    expect(calls).toEqual([]);
    expect(
      (await hit('/c/guarded', { method: 'POST', user: 'ann', tenant: 'acme', roles: 'admin' }))
        .status,
    ).toBe(200);
    expect(calls).toEqual(['ann']);
  });

  it('omits the @Public OpenAPI marker beside a scoped restriction, keeps it otherwise', async () => {
    @Controller('/p')
    class PublicController {
      @Get('/scoped')
      @Public()
      @ScopedRoles(['viewer'])
      scoped() {
        return {};
      }

      @Get('/plain')
      @Public()
      plain() {
        return {};
      }
    }
    await start([PublicController]);
    const routes = app!.router.listRoutes();
    const security = (path: string) =>
      (routes.find((route) => route.path === path)?.definition.schema as
        | { security?: unknown }
        | undefined)
        ?.security;
    expect(security('/p/scoped')).toBeUndefined();
    expect(security('/p/plain')).toEqual([]);
  });
});

describe('@ScopedPermissions and requireScopedPermission — parity', () => {
  it('answer byte-identical 403 and 401 bodies, modulo instance', async () => {
    await start();
    const strip = (body: Record<string, unknown>) => {
      const { instance: _instance, ...rest } = body;
      return rest;
    };
    for (const init of [{ user: 'vic', tenant: 'acme' }, { tenant: 'acme' }]) {
      const decorated = await hit('/c/approve', { method: 'POST', ...init });
      const guarded = await hit('/g/approve', { method: 'POST', ...init });
      expect(decorated.status).toBe(guarded.status);
      expect(strip(decorated.body)).toEqual(strip(guarded.body));
    }
    const allowed = await hit('/g/approve', { method: 'POST', user: 'ann', tenant: 'acme' });
    expect(allowed.status).toBe(200);
  });
});

describe('@ScopedRoles / @ScopedPermissions — register-time refusals', () => {
  it('refuses a name outside the scoped RBAC catalogue, naming the route', async () => {
    @Controller('/bad')
    class Bad {
      @Get('/x')
      @ScopedPermissions(['invoices:aprove'])
      x() {
        return {};
      }
    }
    await expect(start([Bad])).rejects.toThrow(
      '@ScopedPermissions("invoices:aprove"), which is not in the scoped RBAC catalogue',
    );
  });

  it('refuses when AuthPlugin has no scopedRbac — the built-in policy is absent', async () => {
    @Controller('/none')
    class NoScoped {
      @Get('/x')
      @ScopedRoles(['viewer'])
      x() {
        return {};
      }
    }
    await expect(start([NoScoped], {})).rejects.toThrow('not in the scoped RBAC catalogue');
  });

  it('refuses when no policy service is registered at all', async () => {
    @Controller('/none')
    class NoAuth {
      @Get('/x')
      @ScopedRoles(['viewer'])
      x() {
        return {};
      }
    }
    await expect(start([NoAuth], null)).rejects.toThrow(
      'Register AuthPlugin({ rbac, scopedRbac })',
    );
  });
});
