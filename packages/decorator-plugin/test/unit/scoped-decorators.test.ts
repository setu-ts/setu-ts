/**
 * `@ScopedRoles` / `@ScopedPermissions` (M110b plan §3.15): the metadata they
 * record (method overriding class), their decoration-time refusals, the
 * register-time validation, and every per-request arm of the middleware,
 * against a recording stand-in for the policy service.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CAPABILITIES,
  scopedPermissionAbility,
  scopedRoleAbility,
  securityMetadataOf,
} from '@setu-ts/common';
import type {
  HandlerResult,
  IAuthorizationPolicyService,
  IPrincipal,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  MiddlewareFunction,
  PolicyAbilityInfo,
  ScopeRef,
} from '@setu-ts/common';

import { Controller, Get, ScopedPermissions, ScopedRoles } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import {
  appendScopedRbacMiddleware,
  createScopedRbacMiddleware,
} from '../../src/plugin/policy-registration.ts';

const ORG = (id: string): ScopeRef => ({ type: 'organisation', id });

@Controller('/c')
@ScopedRoles(['viewer'])
@ScopedPermissions(['a:read'])
class ClassDefaults {
  @Get('/inherit')
  inherit(): string {
    return 'ok';
  }

  @Get('/override')
  @ScopedRoles(['approver', 'admin'], ORG('o1'))
  @ScopedPermissions(['a:write'])
  override(): string {
    return 'ok';
  }
}

@Controller('/plain')
class Plain {
  @Get('/')
  index(): string {
    return 'ok';
  }
}

describe('@ScopedRoles / @ScopedPermissions — metadata', () => {
  it('records class-level defaults on the controller', () => {
    const ctrl = metadataStore.getController(ClassDefaults);
    expect(ctrl?.scopedRoles).toEqual({ names: ['viewer'] });
    expect(ctrl?.scopedPermissions).toEqual({ names: ['a:read'] });
  });

  it('records a method-level requirement, with its scope only when given', () => {
    const routes = metadataStore.getRoutesFor(ClassDefaults);
    const inherit = routes.find((route) => route.handler === 'inherit');
    const override = routes.find((route) => route.handler === 'override');
    expect(inherit !== undefined && 'scopedRoles' in inherit).toBe(false);
    expect(override?.scopedRoles).toEqual({ names: ['approver', 'admin'], scope: ORG('o1') });
    expect(override?.scopedPermissions).toEqual({ names: ['a:write'] });
  });

  it('copies the names, so mutating the input later changes nothing', () => {
    const names = ['viewer'];
    @Controller('/copy')
    class Copy {
      @Get('/')
      @ScopedRoles(names)
      index(): string {
        return 'ok';
      }
    }
    names.push('admin');
    expect(metadataStore.getRoutesFor(Copy)[0]?.scopedRoles).toEqual({ names: ['viewer'] });
  });

  it('records nothing on an undecorated controller', () => {
    expect(metadataStore.getController(Plain)?.scopedRoles).toBeUndefined();
  });

  it('refuses an empty list and a non-string name at decoration time', () => {
    expect(() => ScopedRoles([])).toThrow('@ScopedRoles() requires a non-empty array of names.');
    expect(() => ScopedPermissions([''])).toThrow(
      '@ScopedPermissions() names must be non-empty strings.',
    );
    expect(() => ScopedRoles([1 as unknown as string])).toThrow('must be non-empty strings');
    expect(() => ScopedRoles('viewer' as unknown as string[])).toThrow('non-empty array');
  });
});

/** A stand-in policy service: `can` answers from a function, `describe` from a record. */
function fakeService(
  allow: (principal: IPrincipal | null, ability: string, target: unknown) => boolean,
  described: Readonly<Record<string, PolicyAbilityInfo>>,
): IAuthorizationPolicyService & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    can: (principal, _policy, ability, target) => {
      calls.push(ability);
      return Promise.resolve(allow(principal, ability, target));
    },
    authorize: () => Promise.resolve(),
    describe: (_policy, ability) => described[ability],
    define: () => {},
  };
}

const KNOWN: Record<string, PolicyAbilityInfo> = {
  [scopedRoleAbility('viewer')]: { anonymous: false },
  [scopedRoleAbility('approver')]: { anonymous: false },
  [scopedPermissionAbility('a:read')]: { anonymous: false },
  [scopedPermissionAbility('a:write')]: { anonymous: false },
};

function context(service: IAuthorizationPolicyService | null, user?: IPrincipal) {
  const recorded = { status: 0, body: undefined as unknown };
  const response = {
    status(code: number) {
      recorded.status = code;
      return response;
    },
    json(body: unknown) {
      recorded.body = body;
      return {} as HandlerResult;
    },
  } as unknown as IResponse;
  const services = {
    has: (token: string) => service !== null && token === CAPABILITIES.AUTHORIZATION_POLICIES,
    get: () => service,
  } as unknown as IServiceRegistry;
  const ctx = {
    request: user === undefined ? {} : { user },
    response,
    services,
    state: new Map<string, unknown>(),
    params: { orgId: 'o1' },
  } as unknown as IRequestContext;
  return { ctx, recorded };
}

async function run(middleware: MiddlewareFunction, ctx: IRequestContext): Promise<boolean> {
  let ran = false;
  await middleware(ctx, () => {
    ran = true;
    return Promise.resolve();
  });
  return ran;
}

const ANN: IPrincipal = { id: 'ann' };
const ROLES = [scopedRoleAbility('viewer'), scopedRoleAbility('approver')];
const PERMS = [scopedPermissionAbility('a:read'), scopedPermissionAbility('a:write')];

describe('createScopedRbacMiddleware', () => {
  it('answers 501 while no policy service is registered', async () => {
    const { ctx, recorded } = context(null, ANN);
    expect(await run(createScopedRbacMiddleware(ROLES, 'any', ORG('o1')), ctx)).toBe(false);
    expect(recorded.status).toBe(501);
  });

  it('answers 401 for an anonymous request before the scope source runs', async () => {
    const service = fakeService(() => true, KNOWN);
    const { ctx, recorded } = context(service);
    let scopeRan = false;
    const scope = () => {
      scopeRan = true;
      return ORG('o1');
    };
    expect(await run(createScopedRbacMiddleware(ROLES, 'any', scope), ctx)).toBe(false);
    expect(recorded.status).toBe(401);
    expect(scopeRan).toBe(false);
    expect(service.calls).toEqual([]);
  });

  it('is any-of for roles: the first grant short-circuits', async () => {
    const service = fakeService((_p, ability) => ability === ROLES[0], KNOWN);
    const { ctx } = context(service, ANN);
    expect(await run(createScopedRbacMiddleware(ROLES, 'any', ORG('o1')), ctx)).toBe(true);
    expect(service.calls).toEqual([ROLES[0]]);
  });

  it('is all-of for permissions: the first deny short-circuits with 403', async () => {
    const service = fakeService((_p, ability) => ability === PERMS[1], KNOWN);
    const { ctx, recorded } = context(service, ANN);
    expect(await run(createScopedRbacMiddleware(PERMS, 'all', ORG('o1')), ctx)).toBe(false);
    expect(recorded.status).toBe(403);
    expect(service.calls).toEqual([PERMS[0]]);
  });

  it('passes all-of when every permission is granted, with the resolved scope as target', async () => {
    const targets: unknown[] = [];
    const service = fakeService((_p, _a, target) => {
      targets.push(target);
      return true;
    }, KNOWN);
    const { ctx } = context(service, ANN);
    const scope = (c: IRequestContext) => ORG(c.params.orgId ?? '');
    expect(await run(createScopedRbacMiddleware(PERMS, 'all', scope), ctx)).toBe(true);
    expect(targets).toEqual([{ scope: ORG('o1'), context: ctx }, {
      scope: ORG('o1'),
      context: ctx,
    }]);
  });

  it('denies any-of when no role is granted', async () => {
    const service = fakeService(() => false, KNOWN);
    const { ctx, recorded } = context(service, ANN);
    expect(await run(createScopedRbacMiddleware(ROLES, 'any', ORG('o1')), ctx)).toBe(false);
    expect(recorded.status).toBe(403);
  });

  it('refuses an ability the registered policy no longer describes, through can()', async () => {
    const service = fakeService(() => true, {});
    const signedIn = context(service, ANN);
    expect(await run(createScopedRbacMiddleware(ROLES, 'any', ORG('o1')), signedIn.ctx)).toBe(
      false,
    );
    expect(signedIn.recorded.status).toBe(403);
    expect(service.calls).toEqual([ROLES[0]]);
    const anonymous = context(service);
    await run(createScopedRbacMiddleware(ROLES, 'any', ORG('o1')), anonymous.ctx);
    expect(anonymous.recorded.status).toBe(401);
  });

  it('lets an anonymous request through to the check only when every ability opts in', async () => {
    const open = { [ROLES[0]!]: { anonymous: true } };
    const deny = fakeService(() => false, open);
    const anonymous = context(deny);
    expect(await run(createScopedRbacMiddleware([ROLES[0]!], 'any', ORG('o1')), anonymous.ctx))
      .toBe(false);
    expect(anonymous.recorded.status).toBe(401);
    expect(deny.calls).toEqual([ROLES[0]]);
    const allow = fakeService(() => true, open);
    expect(await run(createScopedRbacMiddleware([ROLES[0]!], 'any', ORG('o1')), context(allow).ctx))
      .toBe(true);
  });

  it('propagates a throwing scope source', async () => {
    const service = fakeService(() => true, KNOWN);
    const { ctx } = context(service, ANN);
    const scope = () => {
      throw new Error('no scope');
    };
    await expect(run(createScopedRbacMiddleware(ROLES, 'any', scope), ctx)).rejects.toThrow(
      'no scope',
    );
  });

  it('brands the middleware as requiring authentication', () => {
    const middleware = createScopedRbacMiddleware(ROLES, 'any', ORG('o1'));
    expect(securityMetadataOf(middleware)).toEqual({ authenticated: true });
  });
});

describe('appendScopedRbacMiddleware', () => {
  const label = 'Route GET /c/x (C.x)';
  const ctrl = metadataStore.getController(ClassDefaults)!;
  const [inherit, override] = [
    metadataStore.getRoutesFor(ClassDefaults).find((r) => r.handler === 'inherit')!,
    metadataStore.getRoutesFor(ClassDefaults).find((r) => r.handler === 'override')!,
  ];

  it('appends roles then permissions, inheriting class defaults', () => {
    const middleware: MiddlewareFunction[] = [];
    expect(
      appendScopedRbacMiddleware(label, ctrl, inherit, middleware, fakeService(() => true, KNOWN)),
    )
      .toBe(true);
    expect(middleware.length).toBe(2);
  });

  it('appends nothing for a route with no scoped requirement', () => {
    const plainCtrl = metadataStore.getController(Plain)!;
    const [route] = metadataStore.getRoutesFor(Plain);
    const middleware: MiddlewareFunction[] = [];
    expect(appendScopedRbacMiddleware(label, plainCtrl, route!, middleware, undefined)).toBe(false);
    expect(middleware).toEqual([]);
  });

  it('refuses with no policy service, naming the decorator', () => {
    expect(() => appendScopedRbacMiddleware(label, ctrl, inherit, [], undefined)).toThrow(
      `${label} is decorated with @ScopedRoles, but no CAPABILITIES.AUTHORIZATION_POLICIES`,
    );
  });

  it('refuses a name outside the catalogue — the method override is what is checked', () => {
    expect(() =>
      appendScopedRbacMiddleware(label, ctrl, override, [], fakeService(() => true, KNOWN))
    ).toThrow(`${label} is decorated with @ScopedRoles("admin"), which is not in the scoped RBAC`);
  });
});
