/**
 * `definePolicy` and the shared validation (M110a §3.2–§3.3).
 *
 * The refusals are a table iterated as data, so a validation rule removed from
 * the source fails the row that names it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { PolicyDefinition } from '@setu-ts/common';

import {
  definePolicy,
  isAnonymousAbility,
  validatePolicyDefinition,
} from '../../../src/policies/define-policy.ts';
import { requirePolicy } from '../../../src/policies/policy-guard.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';

interface Post {
  readonly authorId: string;
  readonly published: boolean;
}

const allow = (): boolean => true;

const REFUSED: readonly {
  readonly label: string;
  readonly input: unknown;
  readonly says: RegExp;
}[] = [
  { label: 'a non-object', input: 'post', says: /must be an object/ },
  { label: 'null', input: null, says: /must be an object/ },
  { label: 'a missing name', input: { abilities: { read: allow } }, says: /kebab-case/ },
  {
    label: 'an upper-case name',
    input: { name: 'Post', abilities: { read: allow } },
    says: /kebab-case/,
  },
  {
    label: 'a name with a dot',
    input: { name: 'a.b', abilities: { read: allow } },
    says: /kebab-case/,
  },
  {
    label: 'a leading digit',
    input: { name: '1post', abilities: { read: allow } },
    says: /kebab-case/,
  },
  { label: 'missing abilities', input: { name: 'post' }, says: /abilities object/ },
  {
    label: 'array abilities',
    input: { name: 'post', abilities: [allow] },
    says: /abilities object/,
  },
  { label: 'no abilities', input: { name: 'post', abilities: {} }, says: /declares no abilities/ },
  {
    label: 'an ability named before',
    input: { name: 'post', abilities: { before: allow } },
    says: /may not name an ability "before"/,
  },
  {
    label: 'an empty ability name',
    input: { name: 'post', abilities: { '': allow } },
    says: /may not name an ability ""/,
  },
  {
    label: 'a non-function ability',
    input: { name: 'post', abilities: { read: true } },
    says: /ability "read" .* must be a check/,
  },
  {
    label: 'an anonymous arm without a check',
    input: { name: 'post', abilities: { read: { anonymous: true } } },
    says: /ability "read"/,
  },
  {
    label: 'an anonymous arm not marked true',
    input: { name: 'post', abilities: { read: { anonymous: 'yes', check: allow } } },
    says: /ability "read"/,
  },
  {
    label: 'a non-function before',
    input: { name: 'post', abilities: { read: allow }, before: true },
    says: /before of authorization policy "post" must be a function/,
  },
];

describe('validatePolicyDefinition', () => {
  for (const row of REFUSED) {
    it(`refuses ${row.label}`, () => {
      expect(() => validatePolicyDefinition(row.input)).toThrow(AuthPluginConfigurationError);
      expect(() => validatePolicyDefinition(row.input)).toThrow(row.says);
    });
  }

  it('returns a frozen copy whose abilities are own, frozen and detached from the input', () => {
    const abilities: Record<string, unknown> = { read: allow };
    const input = { name: 'post', abilities };
    const copy = validatePolicyDefinition(input);
    abilities.write = allow;
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.abilities)).toBe(true);
    expect(Object.keys(copy.abilities)).toEqual(['read']);
    expect(copy).not.toBe(input);
    expect('before' in copy).toBe(false);
  });

  it('reads a getter-backed ability exactly once', () => {
    let reads = 0;
    const abilities = {
      get read() {
        reads += 1;
        return allow;
      },
    };
    const copy = validatePolicyDefinition({ name: 'post', abilities });
    expect(reads).toBe(1);
    expect(copy.abilities.read).toBe(allow);
    expect(reads).toBe(1);
  });

  it('keeps before and the anonymous arm', () => {
    const before = (): undefined => undefined;
    const copy = validatePolicyDefinition({
      name: 'post',
      abilities: { read: { anonymous: true, check: allow }, write: allow },
      before,
    });
    expect(copy.before).toBe(before);
    expect(isAnonymousAbility(copy.abilities.read as never)).toBe(true);
    expect(isAnonymousAbility(copy.abilities.write as never)).toBe(false);
  });
});

describe('definePolicy', () => {
  it('returns the validated copy typed by ability names and target', () => {
    const postPolicy = definePolicy({
      name: 'post',
      abilities: {
        update: (principal, post: Post | undefined) => post?.authorId === principal.id,
        read: { anonymous: true, check: (_p, post: Post | undefined) => post?.published === true },
      },
    });
    expect(Object.isFrozen(postPolicy)).toBe(true);
    expect(Object.keys(postPolicy.abilities).sort()).toEqual(['read', 'update']);
    // Compile-time: a typed policy is accepted where the registry's type-erased
    // form is declared (the M110a plan-review defect).
    const registered: readonly PolicyDefinition[] = [postPolicy];
    expect(registered).toHaveLength(1);
    // Compile-time: the ability is checked against the policy's own names.
    expect(typeof requirePolicy(postPolicy, 'update')).toBe('function');
    // @ts-expect-error -- 'updaet' is not an ability of postPolicy
    expect(() => requirePolicy(postPolicy, 'updaet')).toThrow(AuthPluginConfigurationError);
  });

  it('refuses a malformed definition', () => {
    expect(() => definePolicy({ name: 'Bad', abilities: { read: allow } })).toThrow(
      AuthPluginConfigurationError,
    );
  });
});
