/**
 * Class-form policy conversion, `@RequirePolicy` validation, and the `@RequirePolicy` middleware
 * (M110a §3.10–§3.11), against a recording stand-in for the policy service so
 * every register-time refusal and per-request status is reachable here.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, securityMetadataOf } from '@setu-ts/common';
import type {
  HandlerResult,
  IAuthorizationPolicyService,
  IPrincipal,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  MiddlewareFunction,
  PolicyAbilityInfo,
  PolicyDefinition,
} from '@setu-ts/common';

import { Ability, Policy } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import {
  appendPolicyMiddleware,
  createPolicyMiddleware,
  registerPolicyClasses,
  toPolicyDefinition,
} from '../../src/plugin/policy-registration.ts';

@Policy('doc')
class DocPolicy {
  constructor(private readonly owner: string = 'ann') {}

  before(principal: IPrincipal): boolean | undefined {
    return principal.roles?.includes('admin') === true ? true : undefined;
  }

  @Ability()
  edit(principal: IPrincipal): boolean {
    return principal.id === this.owner;
  }

  @Ability({ anonymous: true })
  view(principal: IPrincipal | null): boolean {
    return principal === null;
  }
}

@Policy('empty')
class EmptyPolicy {}

class Unmarked {
  @Ability()
  go(): boolean {
    return true;
  }
}

/** A stand-in registry: records definitions, answers `can` from a function. */
function fakeService(
  allow: (principal: IPrincipal | null, name: string, ability: string, target: unknown) => boolean,
  described: Readonly<Record<string, PolicyAbilityInfo>> = {},
): IAuthorizationPolicyService & { readonly defined: PolicyDefinition[] } {
  const defined: PolicyDefinition[] = [];
  return {
    defined,
    can: (principal, policy, ability, target) =>
      Promise.resolve(allow(principal, policy as string, ability, target)),
    authorize: () => Promise.resolve(),
    describe: (policy, ability) => described[`${policy}.${ability}`],
    define: (policy) => {
      defined.push(policy);
    },
  };
}

describe('toPolicyDefinition', () => {
  it('binds abilities and before to the instance, keeping the anonymous arm', async () => {
    const definition = toPolicyDefinition(metadataStore, DocPolicy, new DocPolicy('ann'));
    expect(definition.name).toBe('doc');
    const edit = definition.abilities.edit as (p: IPrincipal, t: unknown) => boolean;
    expect(edit({ id: 'ann' }, undefined)).toBe(true);
    expect(edit({ id: 'bob' }, undefined)).toBe(false);
    const view = definition.abilities.view as {
      readonly anonymous: true;
      readonly check: (p: IPrincipal | null, t: unknown) => boolean;
    };
    expect(view.anonymous).toBe(true);
    expect(view.check(null, undefined)).toBe(true);
    expect(await definition.before?.({ id: 'x', roles: ['admin'] }, 'edit', undefined as never))
      .toBe(true);
  });

  it('omits before when the class has none', () => {
    @Policy('no-before')
    class NoBefore {
      @Ability()
      go(): boolean {
        return true;
      }
    }
    expect('before' in toPolicyDefinition(metadataStore, NoBefore, new NoBefore())).toBe(false);
  });

  it('refuses a class without @Policy', () => {
    expect(() => toPolicyDefinition(metadataStore, Unmarked, new Unmarked())).toThrow(
      /Unmarked is listed in policies but carries no @Policy\(name\)/,
    );
  });

  it('refuses a policy class with no @Ability', () => {
    expect(() => toPolicyDefinition(metadataStore, EmptyPolicy, new EmptyPolicy())).toThrow(
      /policy class EmptyPolicy declares no @Ability\(\) method/,
    );
  });

  it('refuses an ability the instance shadows with a non-function', () => {
    const instance = Object.assign(new DocPolicy(), { edit: 'shadowed' });
    expect(() => toPolicyDefinition(metadataStore, DocPolicy, instance)).toThrow(
      /DocPolicy\.edit is not a method/,
    );
  });
});

describe('registerPolicyClasses', () => {
  it('does nothing for an empty list, even without a service', () => {
    expect(() => registerPolicyClasses(metadataStore, [], undefined, () => ({}))).not.toThrow();
  });

  it('refuses listed classes when no policy service is registered', () => {
    expect(() => registerPolicyClasses(metadataStore, [DocPolicy], undefined, () => ({})))
      .toThrow(/policies lists DocPolicy, but no CAPABILITIES.AUTHORIZATION_POLICIES provider/);
  });

  it('constructs each class through the given constructor and defines it', () => {
    const service = fakeService(() => true);
    const constructed: unknown[] = [];
    registerPolicyClasses(metadataStore, [DocPolicy], service, (target) => {
      constructed.push(target);
      return new DocPolicy('bob');
    });
    expect(constructed).toEqual([DocPolicy]);
    expect(service.defined.map((d) => d.name)).toEqual(['doc']);
  });
});

describe('appendPolicyMiddleware', () => {
  const described = {
    'doc.edit': { anonymous: false },
    'doc.view': { anonymous: true },
  } as const;

  it('appends nothing and reports no requirement for an undecorated route', () => {
    const middleware: MiddlewareFunction[] = [];
    expect(appendPolicyMiddleware(metadataStore, 'Route', [], middleware, undefined)).toBe(false);
    expect(middleware).toHaveLength(0);
  });

  it('refuses @RequirePolicy when no policy service is registered', () => {
    expect(() =>
      appendPolicyMiddleware(
        metadataStore,
        'Route GET /x (C.m)',
        [{ policy: DocPolicy, ability: 'edit' }],
        [],
        undefined,
      )
    ).toThrow(
      'Route GET /x (C.m) is decorated with @RequirePolicy, but no CAPABILITIES.AUTHORIZATION_POLICIES',
    );
  });

  it('refuses an unregistered ability, a definition, and an unmarked class by name', () => {
    const service = fakeService(() => true, described);
    const call = (policy: unknown, ability: string) => () =>
      appendPolicyMiddleware(
        metadataStore,
        'Route',
        [{ policy: policy as typeof DocPolicy, ability }],
        [],
        service,
      );
    expect(call(DocPolicy, 'delete')).toThrow(
      '@RequirePolicy("doc", "delete"), but no such policy ability',
    );
    expect(call({ name: 'invoice', abilities: {} }, 'approve')).toThrow(
      '@RequirePolicy("invoice", "approve")',
    );
    expect(call(Unmarked, 'go')).toThrow('@RequirePolicy(Unmarked (no @Policy), "go")');
    expect(call({ abilities: {} }, 'go')).toThrow('@RequirePolicy([unnamed policy], "go")');
  });

  it('appends one middleware per requirement and reports whether any needs a principal', () => {
    const service = fakeService(() => true, described);
    const anonymousOnly: MiddlewareFunction[] = [];
    expect(
      appendPolicyMiddleware(
        metadataStore,
        'Route',
        [{ policy: DocPolicy, ability: 'view' }],
        anonymousOnly,
        service,
      ),
    ).toBe(false);
    expect(securityMetadataOf(anonymousOnly[0] as MiddlewareFunction)).toEqual({
      authenticated: false,
    });
    const both: MiddlewareFunction[] = [];
    expect(
      appendPolicyMiddleware(
        metadataStore,
        'Route',
        [{ policy: DocPolicy, ability: 'view' }, {
          // A definition referenced by @RequirePolicy must DECLARE the ability it names,
          // matching the registered one on `anonymous` (audit F4).
          policy: { name: 'doc', abilities: { edit: () => true } } as unknown as PolicyDefinition,
          ability: 'edit',
        }],
        both,
        service,
      ),
    ).toBe(true);
    expect(both.map((m) => securityMetadataOf(m))).toEqual([
      { authenticated: false },
      { authenticated: true },
    ]);
  });
});

describe('createPolicyMiddleware', () => {
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
      params: { id: 'p1' },
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

  it('answers 501 while no policy service is registered', async () => {
    const { ctx, recorded } = context(null, { id: 'ann' });
    expect(await run(createPolicyMiddleware('doc', 'edit', undefined, false), ctx)).toBe(false);
    expect(recorded).toEqual({
      status: 501,
      body: { error: 'Not Implemented', detail: 'Authorization is not configured' },
    });
  });

  it('answers 401 for a denied anonymous request and 403 for a denied principal', async () => {
    const deny = fakeService(() => false);
    const anonymous = context(deny);
    expect(await run(createPolicyMiddleware('doc', 'edit', undefined, false), anonymous.ctx)).toBe(
      false,
    );
    expect(anonymous.recorded.status).toBe(401);
    const signedIn = context(deny, { id: 'bob' });
    expect(await run(createPolicyMiddleware('doc', 'edit', undefined, false), signedIn.ctx)).toBe(
      false,
    );
    expect(signedIn.recorded).toEqual({
      status: 403,
      body: { error: 'Forbidden', detail: 'Insufficient privileges' },
    });
  });

  it('passes the principal, names and resolved target, and continues when allowed', async () => {
    const seen: unknown[] = [];
    const service = fakeService((principal, name, ability, target) => {
      seen.push(principal?.id, name, ability, target);
      return true;
    });
    const fixed = context(service, { id: 'ann' });
    expect(await run(createPolicyMiddleware('doc', 'edit', { owner: 'ann' }, false), fixed.ctx))
      .toBe(
        true,
      );
    const extracted = context(service, { id: 'ann' });
    const extractor = (ctx: IRequestContext) => Promise.resolve({ owner: ctx.params.id });
    expect(await run(createPolicyMiddleware('doc', 'edit', extractor, false), extracted.ctx)).toBe(
      true,
    );
    expect(seen).toEqual(['ann', 'doc', 'edit', { owner: 'ann' }, 'ann', 'doc', 'edit', {
      owner: 'p1',
    }]);
  });

  it('propagates an extractor throw without continuing', async () => {
    const { ctx } = context(fakeService(() => true), { id: 'ann' });
    const outage = new Error('db');
    let ran = false;
    const thrown = await Promise.resolve(
      createPolicyMiddleware('doc', 'edit', () => Promise.reject(outage), false)(ctx, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).catch((e: unknown) => e);
    expect(thrown).toBe(outage);
    expect(ran).toBe(false);
  });
});

describe('audit F1: @RequirePolicy refuses anonymous before running the extractor', () => {
  it('answers 401 without calling the extractor for a non-anonymous ability', async () => {
    const recorded = { status: 0 };
    const response = {
      status(code: number) {
        recorded.status = code;
        return response;
      },
      json: () => ({}) as HandlerResult,
    } as unknown as IResponse;
    const service = fakeService(() => true);
    const ctx = {
      request: {},
      response,
      services: { has: () => true, get: () => service } as unknown as IServiceRegistry,
      state: new Map<string, unknown>(),
      params: {},
    } as unknown as IRequestContext;
    let extracted = 0;
    const extractor = () => {
      extracted += 1;
      return Promise.reject(new Error('not found'));
    };
    let ran = false;
    await createPolicyMiddleware('doc', 'edit', extractor, false)(ctx, () => {
      ran = true;
      return Promise.resolve();
    });
    expect([recorded.status, extracted, ran]).toEqual([401, 0, false]);
  });
});

describe('audit F4: @RequirePolicy refuses a policy that disagrees with the registered one', () => {
  const described = { 'doc.edit': { anonymous: false }, 'doc.view': { anonymous: true } } as const;
  const call = (policy: unknown, ability: string) => () =>
    appendPolicyMiddleware(
      metadataStore,
      'Route GET /x (C.m)',
      [{ policy: policy as typeof DocPolicy, ability }],
      [],
      fakeService(() => true, described),
    );

  it('refuses a same-named definition whose ability disagrees on anonymous', () => {
    const impostor = {
      name: 'doc',
      abilities: { view: () => true },
    } as unknown as PolicyDefinition;
    expect(call(impostor, 'view')).toThrow(
      'a different policy is registered under the same name',
    );
  });

  it('refuses a same-named definition that does not declare the ability', () => {
    const impostor = {
      name: 'doc',
      abilities: { other: () => true },
    } as unknown as PolicyDefinition;
    expect(call(impostor, 'edit')).toThrow('a different policy is registered under the same name');
  });

  it('refuses a same-named class whose ability disagrees on anonymous', () => {
    @Policy('doc')
    class Impostor {
      @Ability()
      view(): boolean {
        return true;
      }
    }
    expect(call(Impostor, 'view')).toThrow('a different policy is registered under the same name');
  });

  it('accepts the registered class and a matching definition', () => {
    expect(call(DocPolicy, 'view')).not.toThrow();
    const matching = {
      name: 'doc',
      abilities: { edit: () => true, view: { anonymous: true, check: () => true } },
    } as unknown as PolicyDefinition;
    expect(call(matching, 'edit')).not.toThrow();
  });
});
