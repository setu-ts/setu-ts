/**
 * The `requirePolicy` route guard (M110a §3.6, §3.10): every refusal
 * short-circuits — `next()`, and therefore the handler, never runs — and the
 * guard carries the brands the startup scan and OpenAPI read.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, securityMetadataOf } from '@setu-ts/common';
import type {
  HandlerResult,
  IPrincipal,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  PolicyDefinition,
} from '@setu-ts/common';

import { definePolicy } from '../../../src/policies/define-policy.ts';
import { policyGuardOf, requirePolicy } from '../../../src/policies/policy-guard.ts';
import { PolicyService } from '../../../src/policies/policy-service.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';

interface Doc {
  readonly owner: string;
}

const docPolicy = definePolicy({
  name: 'doc',
  abilities: {
    edit: (principal, doc: Doc | undefined) => doc?.owner === principal.id,
    view: { anonymous: true, check: () => true },
  },
});

interface Harness {
  readonly ctx: IRequestContext;
  readonly recorded: { status: number; body: unknown };
}

/** A context whose registry holds the given policy service, or nothing. */
function context(service: PolicyService | null, user?: IPrincipal): Harness {
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
    get: (token: string) => {
      if (service === null || token !== CAPABILITIES.AUTHORIZATION_POLICIES) {
        throw new Error(`no ${token}`);
      }
      return service;
    },
  } as unknown as IServiceRegistry;
  const ctx = {
    request: user === undefined ? {} : { user },
    response,
    services,
    state: new Map<string, unknown>(),
    params: { id: 'd1' },
  } as unknown as IRequestContext;
  return { ctx, recorded };
}

function registered(): PolicyService {
  const service = new PolicyService(() => undefined);
  service.define(docPolicy);
  return service;
}

/** Runs the guard and reports whether `next()` ran. */
async function run(
  guard: ReturnType<typeof requirePolicy>,
  harness: Harness,
): Promise<boolean> {
  let nextRan = false;
  await guard(harness.ctx, () => {
    nextRan = true;
    return Promise.resolve();
  });
  return nextRan;
}

describe('requirePolicy — refusals short-circuit', () => {
  it('answers 501 when no policy service is registered', async () => {
    const harness = context(null, { id: 'ann' });
    expect(await run(requirePolicy(docPolicy, 'edit', { owner: 'ann' }), harness)).toBe(false);
    expect(harness.recorded).toEqual({
      status: 501,
      body: { error: 'Not Implemented', detail: 'Authorization is not configured' },
    });
  });

  it('answers 401 for an anonymous request to a non-anonymous ability', async () => {
    const harness = context(registered());
    expect(await run(requirePolicy(docPolicy, 'edit', { owner: 'ann' }), harness)).toBe(false);
    expect(harness.recorded).toEqual({
      status: 401,
      body: { error: 'Unauthorized', detail: 'Authentication required' },
    });
  });

  it('answers 403 when a signed-in principal is denied', async () => {
    const harness = context(registered(), { id: 'bob' });
    expect(await run(requirePolicy(docPolicy, 'edit', { owner: 'ann' }), harness)).toBe(false);
    expect(harness.recorded).toEqual({
      status: 403,
      body: { error: 'Forbidden', detail: 'Insufficient privileges' },
    });
  });
});

describe('requirePolicy — allowing', () => {
  it('calls next() and writes nothing when allowed', async () => {
    const harness = context(registered(), { id: 'ann' });
    expect(await run(requirePolicy(docPolicy, 'edit', { owner: 'ann' }), harness)).toBe(true);
    expect(harness.recorded.status).toBe(0);
  });

  it('lets an anonymous request through an anonymous ability', async () => {
    const harness = context(registered());
    expect(await run(requirePolicy(docPolicy, 'view'), harness)).toBe(true);
  });

  it('resolves a synchronous extractor against the request', async () => {
    const harness = context(registered(), { id: 'ann' });
    const guard = requirePolicy(
      docPolicy,
      'edit',
      (ctx) => ({ owner: ctx.request.user?.id ?? '' }),
    );
    expect(await run(guard, harness)).toBe(true);
  });

  it('awaits an asynchronous extractor', async () => {
    const harness = context(registered(), { id: 'bob' });
    const guard = requirePolicy(docPolicy, 'edit', () => Promise.resolve({ owner: 'ann' }));
    expect(await run(guard, harness)).toBe(false);
    expect(harness.recorded.status).toBe(403);
  });
});

describe('requirePolicy — failures that are not refusals', () => {
  it('propagates an extractor throw unchanged, without running next()', async () => {
    const harness = context(registered(), { id: 'ann' });
    const outage = new Error('database unavailable');
    const guard = requirePolicy(docPolicy, 'edit', () => Promise.reject(outage));
    let nextRan = false;
    const thrown = await Promise.resolve(guard(harness.ctx, () => {
      nextRan = true;
      return Promise.resolve();
    })).catch((e: unknown) => e);
    expect(thrown).toBe(outage);
    expect(nextRan).toBe(false);
    expect(harness.recorded.status).toBe(0);
  });

  it('propagates the registry rejection for an unregistered policy (fail closed)', async () => {
    const harness = context(new PolicyService(() => undefined), { id: 'ann' });
    const guard = requirePolicy(docPolicy, 'edit', { owner: 'ann' });
    let nextRan = false;
    await expect(Promise.resolve(guard(harness.ctx, () => {
      nextRan = true;
      return Promise.resolve();
    }))).rejects.toThrow(/no authorization policy named "doc"/);
    expect(nextRan).toBe(false);
  });
});

describe('requirePolicy — construction and brands', () => {
  it('refuses an ability the policy object does not declare', () => {
    const unchecked = docPolicy as unknown as PolicyDefinition<string, never>;
    expect(() => requirePolicy(unchecked, 'delete')).toThrow(AuthPluginConfigurationError);
    expect(() => requirePolicy(unchecked, 'constructor')).toThrow(/"constructor"/);
    expect(() => requirePolicy(unchecked, Object.create(null) as string)).toThrow(/"\[object\]"/);
    const nameless = { abilities: { edit: () => true } } as unknown as PolicyDefinition<
      'edit',
      never
    >;
    expect(() => requirePolicy(nameless, 'edit')).toThrow(/"\[undefined\]"/);
  });

  it('brands a non-anonymous ability as authenticated for OpenAPI', () => {
    const guard = requirePolicy(docPolicy, 'edit');
    expect(securityMetadataOf(guard)).toEqual({ authenticated: true });
    expect(policyGuardOf(guard)).toEqual({ policy: 'doc', ability: 'edit', anonymous: false });
  });

  it('brands an anonymous ability as not requiring authentication', () => {
    const guard = requirePolicy(docPolicy, 'view');
    expect(securityMetadataOf(guard)).toEqual({ authenticated: false });
    expect(policyGuardOf(guard)?.anonymous).toBe(true);
  });

  it('reads no brand off an ordinary or malformed middleware', () => {
    const plain = (_ctx: IRequestContext, next: () => Promise<void>) => next();
    expect(policyGuardOf(plain)).toBeUndefined();
    const forged = Object.assign(plain, {
      [Symbol.for('setu.auth.policy-guard')]: { policy: 'doc', ability: 1, anonymous: false },
    });
    expect(policyGuardOf(forged)).toBeUndefined();
    const nullBrand = Object.assign(() => Promise.resolve(), {
      [Symbol.for('setu.auth.policy-guard')]: null,
    });
    expect(policyGuardOf(nullBrand)).toBeUndefined();
  });

  it('keeps the brand non-enumerable and immutable', () => {
    const guard = requirePolicy(docPolicy, 'edit');
    expect(Object.keys(guard)).toEqual([]);
    expect(() => {
      Object.defineProperty(guard, Symbol.for('setu.auth.policy-guard'), { value: null });
    }).toThrow(TypeError);
  });
});

describe('requirePolicy — audit F1: anonymous refusal precedes the extractor', () => {
  it('refuses an anonymous request to a non-anonymous ability without running the extractor', async () => {
    const harness = context(registered());
    let extracted = 0;
    const guard = requirePolicy(docPolicy, 'edit', () => {
      extracted += 1;
      return Promise.reject(new Error('not found'));
    });
    expect(await run(guard, harness)).toBe(false);
    expect(harness.recorded.status).toBe(401);
    expect(extracted).toBe(0);
  });

  it('still runs the extractor for an anonymous ability, which decides with the target', async () => {
    const harness = context(registered());
    let extracted = 0;
    const guard = requirePolicy(docPolicy, 'view', () => {
      extracted += 1;
      return { owner: 'x' };
    });
    expect(await run(guard, harness)).toBe(true);
    expect(extracted).toBe(1);
  });
});

describe('requirePolicy — audit G1: the registered policy decides, not the guard object', () => {
  /** Same name as the registered `doc`, but declaring `edit` anonymous and `view` not. */
  const impostor = definePolicy({
    name: 'doc',
    abilities: {
      edit: { anonymous: true, check: () => true },
      view: () => true,
    },
  });

  it('refuses anonymous before extracting when the registered ability needs a principal', async () => {
    const harness = context(registered());
    let extracted = 0;
    const guard = requirePolicy(impostor, 'edit', () => {
      extracted += 1;
      return Promise.reject(new Error('not found'));
    });
    expect(await run(guard, harness)).toBe(false);
    expect(harness.recorded.status).toBe(401);
    expect(extracted).toBe(0);
  });

  it('extracts for an ability the registry declares anonymous, whatever the guard object says', async () => {
    const harness = context(registered());
    let extracted = 0;
    const guard = requirePolicy(impostor, 'view', () => {
      extracted += 1;
      return { owner: 'x' };
    });
    expect(await run(guard, harness)).toBe(true);
    expect(extracted).toBe(1);
  });

  it('rejects an unregistered policy per request without running the extractor', async () => {
    const harness = context(new PolicyService(() => undefined));
    let extracted = 0;
    const guard = requirePolicy(docPolicy, 'edit', () => {
      extracted += 1;
      return { owner: 'x' };
    });
    await expect(run(guard, harness)).rejects.toThrow(/no authorization policy named "doc"/);
    expect(extracted).toBe(0);
    expect(harness.recorded.status).toBe(0);
  });

  it('fails closed when a replacement provider describes nothing yet allows', async () => {
    for (const user of [undefined, { id: 'ann' }] as const) {
      const lenient = {
        describe: () => undefined,
        can: () => Promise.resolve(true),
      } as unknown as PolicyService;
      const harness = context(lenient, user);
      let extracted = 0;
      const guard = requirePolicy(docPolicy, 'edit', () => {
        extracted += 1;
        return { owner: 'ann' };
      });
      expect(await run(guard, harness)).toBe(false);
      expect(harness.recorded.status).toBe(user === undefined ? 401 : 403);
      expect(extracted).toBe(0);
    }
  });
});
