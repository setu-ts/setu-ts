/**
 * Contract tests for the authorization policy types (M110a §3.1–§3.2).
 *
 * Most rows here are COMPILE-TIME: `deno check` reaches this file, so a
 * reverted typing choice fails the type-check rather than a runtime
 * assertion. The first draft of this contract declared `before` as a
 * function-typed property with a default target of `unknown`, and a typed
 * policy was then not assignable to the bare `PolicyDefinition` a registry
 * stores (`TS2322`) — the rows below pin both fixes.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES, createCapabilityToken } from '../../src/index.ts';
import type {
  IAuthorizationPolicyService,
  IPrincipal,
  PolicyAbility,
  PolicyAbilityInfo,
  PolicyDefinition,
  PolicyRef,
} from '../../src/index.ts';

interface Post {
  readonly authorId: string;
  readonly published: boolean;
}

const postPolicy: PolicyDefinition<'update' | 'read', Post> = {
  name: 'post',
  abilities: {
    update: (principal, post) => post?.authorId === principal.id,
    read: { anonymous: true, check: (_principal, post) => post?.published === true },
  },
  before(principal, ability) {
    // `ability` is the policy's own union, not `string`.
    const narrowed: 'update' | 'read' = ability;
    return narrowed === 'update' && principal.roles?.includes('admin') === true ? true : undefined;
  },
};

/** A stand-in registry with the contract's exact signatures. */
function registry(): IAuthorizationPolicyService & { readonly defined: PolicyDefinition[] } {
  const defined: PolicyDefinition[] = [];
  return {
    defined,
    can: () => Promise.resolve(true),
    authorize: () => Promise.resolve(),
    describe: (): PolicyAbilityInfo | undefined => undefined,
    define(policy) {
      defined.push(policy);
    },
  };
}

describe('CAPABILITIES.AUTHORIZATION_POLICIES', () => {
  it('is the kebab-case token the grammar accepts, distinct from the RBAC token', () => {
    expect(CAPABILITIES.AUTHORIZATION_POLICIES).toBe('authorization-policies');
    expect(createCapabilityToken(CAPABILITIES.AUTHORIZATION_POLICIES)).toBe(
      'authorization-policies',
    );
    expect(CAPABILITIES.AUTHORIZATION_POLICIES).not.toBe(CAPABILITIES.AUTHORIZATION);
  });
});

describe('PolicyDefinition typing', () => {
  it('accepts a typed policy where the type-erased registry form is declared', () => {
    // Compile-time: this assignment is the M110a review defect. It fails
    // `deno check` if `before` reverts to a property or the default target
    // reverts to `unknown`.
    const registered: readonly PolicyDefinition[] = [postPolicy];
    const service = registry();
    service.define(postPolicy);
    expect(registered).toHaveLength(1);
    expect(service.defined[0]?.name).toBe('post');
  });

  it('types the imperative call against the policy object', async () => {
    const service = registry();
    const principal: IPrincipal = { id: 'u1' };
    const post: Post = { authorId: 'u1', published: false };
    expect(await service.can(principal, postPolicy, 'update', post)).toBe(true);
    // @ts-expect-error -- 'updaet' is not an ability of postPolicy
    expect(await service.can(principal, postPolicy, 'updaet', post)).toBe(true);
    // A string reference names any ability: the registry refuses an unknown
    // one at runtime, by name.
    const byName: PolicyRef<'anything', Post> = 'post';
    expect(await service.can(principal, byName, 'anything')).toBe(true);
  });

  it('types a plain check for a signed-in principal and an anonymous one for null', () => {
    // A plain check reads the principal with no null handling…
    const plain: PolicyAbility<Post> = (p) => p.id.length > 0;
    // …while an anonymous check must handle null before reading it.
    const anonymous: PolicyAbility<Post> = {
      anonymous: true,
      // @ts-expect-error -- 'p' is possibly null in an anonymous check
      check: (p) => p.id.length > 0,
    };
    const handled: PolicyAbility<Post> = { anonymous: true, check: (p) => p === null };
    expect(typeof plain).toBe('function');
    expect(typeof anonymous).toBe('object');
    expect(typeof handled).toBe('object');
  });
});
