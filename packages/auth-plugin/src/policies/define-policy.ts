/**
 * Policy definition and its validation — the one place a malformed policy is
 * refused, shared by `definePolicy`, `AuthPluginOptions.policies` and
 * `IAuthorizationPolicyService.define`.
 *
 * @module
 */
import type { PolicyAbility, PolicyDefinition } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';

/** A policy name: lowercase kebab-case, so it is log-safe and greppable. */
const POLICY_NAME = /^[a-z][a-z0-9-]*$/;

/** The one name an ability may not take — it is the policy's own hook. */
const RESERVED_ABILITY = 'before';

/**
 * Reads the anonymous arm's check, or `undefined` when the value is not a
 * well-formed `{ anonymous: true, check }`.
 *
 * Each member is read EXACTLY ONCE and the value read is the value returned:
 * a getter answering one function to the validation and another to the copy
 * would otherwise register a check that was never validated (audit F3).
 */
function anonymousCheckOf(value: unknown): ((...args: never[]) => unknown) | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const arm = value as { readonly anonymous?: unknown; readonly check?: unknown };
  if (arm.anonymous !== true) {
    return undefined;
  }
  const check = arm.check;
  return typeof check === 'function' ? check as (...args: never[]) => unknown : undefined;
}

/**
 * Reports whether an ability is evaluated for anonymous principals.
 *
 * @param ability - A validated ability
 * @returns `true` for the `{ anonymous: true, check }` arm
 */
export function isAnonymousAbility(ability: PolicyAbility<never>): boolean {
  return typeof ability !== 'function';
}

/**
 * Validates a policy definition and returns a frozen copy.
 *
 * Every member is read ONCE, here: the copy is what the evaluator consults, so
 * an object whose getters answer differently on a second read cannot change
 * an ability after it was validated. The abilities copy is keyed by the
 * definition's OWN enumerable string keys; evaluation looks abilities up with
 * `Object.hasOwn`, so `constructor`, `toString` and `__proto__` never resolve
 * as abilities.
 *
 * Internal: not exported from the package barrel.
 *
 * @param definition - The candidate definition
 * @returns The frozen, validated copy
 * @throws {AuthPluginConfigurationError} When the definition is malformed
 */
export function validatePolicyDefinition(definition: unknown): PolicyDefinition {
  if (typeof definition !== 'object' || definition === null) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: an authorization policy must be an object with a name and abilities',
    );
  }
  const candidate = definition as {
    readonly name?: unknown;
    readonly abilities?: unknown;
    readonly before?: unknown;
  };
  const name = candidate.name;
  if (typeof name !== 'string' || !POLICY_NAME.test(name)) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: an authorization policy name must be lowercase kebab-case ' +
        `(${POLICY_NAME.source})`,
    );
  }
  const label = JSON.stringify(name);
  const abilities = candidate.abilities;
  if (typeof abilities !== 'object' || abilities === null || Array.isArray(abilities)) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: authorization policy ${label} must declare an abilities object`,
    );
  }
  const keys = Object.keys(abilities);
  if (keys.length === 0) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: authorization policy ${label} declares no abilities`,
    );
  }
  const copy: Record<string, PolicyAbility<never>> = {};
  for (const key of keys) {
    if (key === RESERVED_ABILITY || key.length === 0) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: authorization policy ${label} may not name an ability ` +
          `${JSON.stringify(key)}`,
      );
    }
    const value = (abilities as Record<string, unknown>)[key];
    const anonymousCheck = typeof value === 'function' ? undefined : anonymousCheckOf(value);
    if (typeof value === 'function') {
      copy[key] = value as PolicyAbility<never>;
    } else if (anonymousCheck !== undefined) {
      copy[key] = Object.freeze({ anonymous: true, check: anonymousCheck }) as PolicyAbility<never>;
    } else {
      throw new AuthPluginConfigurationError(
        `auth-plugin: ability ${JSON.stringify(key)} of authorization policy ${label} must be a ` +
          'check function or { anonymous: true, check }',
      );
    }
  }
  const before = candidate.before;
  if (before !== undefined && typeof before !== 'function') {
    throw new AuthPluginConfigurationError(
      `auth-plugin: before of authorization policy ${label} must be a function`,
    );
  }
  const frozenAbilities = Object.freeze(copy);
  return Object.freeze(
    before === undefined ? { name, abilities: frozenAbilities } : {
      name,
      abilities: frozenAbilities,
      before: before as NonNullable<PolicyDefinition['before']>,
    },
  );
}

/**
 * Defines an authorization policy: validates it and returns a frozen copy
 * typed by its ability names and target, so `requirePolicy(policy, 'updaet')`
 * is a compile error.
 *
 * The target type is inferred from a check's annotated parameter; an
 * unannotated check receives `unknown`. Only a literal `true` allows. An
 * ability sees an anonymous (`null`) principal only when declared as
 * `{ anonymous: true, check }`; otherwise an anonymous request is denied
 * (`401`) before the check runs. `before` runs for a signed-in principal only:
 * `true` allows, `undefined` falls through, anything else — `null` included —
 * denies.
 *
 * Register the result through `AuthPlugin({ policies: [...] })`.
 *
 * @param definition - The policy
 * @returns The validated, frozen policy
 * @throws {AuthPluginConfigurationError} When the name is not lowercase
 * kebab-case, there are no abilities, an ability is named `before` or is not a
 * check, or `before` is not a function
 * @example
 * ```typescript
 * const postPolicy = definePolicy({
 *   name: 'post',
 *   abilities: {
 *     update: (principal, post: Post | undefined) => post?.authorId === principal.id,
 *     read: { anonymous: true, check: (_principal, post: Post | undefined) => post?.published === true },
 *   },
 *   before: (principal) => (principal.roles?.includes('admin') ? true : undefined),
 * });
 * ```
 * @since 0.9.0
 */
export function definePolicy<A extends string, T>(
  definition: PolicyDefinition<A, T>,
): PolicyDefinition<A, T> {
  return validatePolicyDefinition(definition) as unknown as PolicyDefinition<A, T>;
}
