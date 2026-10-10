/**
 * Class-form policy registration and `@RequirePolicy` enforcement (M110a §3.11).
 *
 * This package may not import AuthPlugin (AI_GUIDELINES §2.2), so `@RequirePolicy`
 * builds its own thin middleware over the PUBLIC
 * `IAuthorizationPolicyService` contract; the evaluation itself stays in the
 * one service AuthPlugin registers. The refusals match the `requirePolicy`
 * guard's — both write through the shared `respondWithAuthorizationFailure`
 * — and a parity test drives the two together.
 *
 * Not exported from the package barrel.
 *
 * @module
 */
import {
  CAPABILITIES,
  respondWithAuthorizationFailure,
  withSecurityMetadata,
} from '@setu-ts/common';
import type {
  Constructor,
  IAuthorizationPolicyService,
  IPrincipal,
  IRequestContext,
  MiddlewareFunction,
  PolicyAbility,
  PolicyDefinition,
} from '@setu-ts/common';
import type { MetadataStore, PolicyRequirement } from '../metadata/metadata-store.ts';
import { className } from '../internal.ts';

/** The one method name that is the policy's hook rather than an ability. */
const BEFORE = 'before';

/** A method on a policy instance, looked up dynamically. */
type PolicyMethod = (...args: readonly unknown[]) => unknown;

/** Reads a method off an instance, or `undefined` when it is not a function. */
function methodOf(instance: unknown, name: string): PolicyMethod | undefined {
  const value = (instance as Record<string, unknown>)[name];
  return typeof value === 'function' ? value as PolicyMethod : undefined;
}

/**
 * Converts a constructed `@Policy` instance into a definition whose checks
 * call the instance's methods, bound to it.
 *
 * @param store - The metadata store
 * @param target - The policy class
 * @param instance - The constructed instance
 * @returns The definition to register
 * @throws {Error} When the class carries no `@Policy`, no `@Ability`, or an
 *   ability that is not a method
 */
export function toPolicyDefinition(
  store: MetadataStore,
  target: Constructor,
  instance: unknown,
): PolicyDefinition {
  const meta = store.getPolicyClass(target);
  const label = className(target);
  if (meta?.name === undefined) {
    throw new Error(
      `DecoratorPlugin: ${label} is listed in policies but carries no @Policy(name) decorator.`,
    );
  }
  if (meta.abilities.size === 0) {
    throw new Error(
      `DecoratorPlugin: policy class ${label} declares no @Ability() method.`,
    );
  }
  const abilities: Record<string, PolicyAbility<never>> = {};
  for (const [method, anonymous] of meta.abilities) {
    const fn = methodOf(instance, method);
    if (fn === undefined) {
      throw new Error(
        `DecoratorPlugin: @Ability() ${label}.${method} is not a method on the instance.`,
      );
    }
    const check = (principal: IPrincipal | null, value: unknown): unknown =>
      fn.call(instance, principal, value);
    abilities[method] = (anonymous
      ? { anonymous: true, check }
      : (principal: IPrincipal, value: unknown) =>
        check(principal, value)) as PolicyAbility<
        never
      >;
  }
  const before = methodOf(instance, BEFORE);
  return before === undefined ? { name: meta.name, abilities } : {
    name: meta.name,
    abilities,
    before: (principal, ability, value) =>
      before.call(instance, principal, ability, value) as boolean | undefined,
  };
}

/**
 * Constructs and registers every class listed in `DecoratorPlugin({ policies })`.
 *
 * @param store - The metadata store
 * @param classes - The policy classes
 * @param service - The registration-time policy service, if any
 * @param construct - DI-aware construction (container registration first)
 * @throws {Error} When classes are listed but no policy service is
 *   registered, or a class or definition is refused
 */
export function registerPolicyClasses(
  store: MetadataStore,
  classes: readonly Constructor[],
  service: IAuthorizationPolicyService | undefined,
  construct: (target: Constructor) => unknown,
): void {
  if (classes.length === 0) {
    return;
  }
  if (service === undefined) {
    throw new Error(
      `DecoratorPlugin: policies lists ${classes.map(className).join(', ')}, but no ` +
        'CAPABILITIES.AUTHORIZATION_POLICIES provider is registered. Register AuthPlugin from ' +
        '@setu-ts/auth-plugin.',
    );
  }
  for (const target of classes) {
    service.define(toPolicyDefinition(store, target, construct(target)));
  }
}

/** Resolves a requirement's policy to its NAME, or `undefined` for an unmarked class. */
function policyName(
  store: MetadataStore,
  policy: Constructor | PolicyDefinition,
): string | undefined {
  if (typeof policy === 'function') {
    return store.getPolicyClass(policy)?.name;
  }
  return typeof policy.name === 'string' ? policy.name : undefined;
}

/**
 * What the referenced policy itself declares about an ability's `anonymous`
 * flag — read from the `@Policy` class's metadata or the definition object —
 * or `undefined` when it does not declare the ability at all.
 */
function declaredAnonymous(
  store: MetadataStore,
  policy: Constructor | PolicyDefinition,
  ability: string,
): boolean | undefined {
  if (typeof policy === 'function') {
    return store.getPolicyClass(policy)?.abilities.get(ability);
  }
  const abilities: unknown = policy.abilities;
  if (typeof abilities !== 'object' || abilities === null || !Object.hasOwn(abilities, ability)) {
    return undefined;
  }
  return typeof (abilities as Record<string, unknown>)[ability] !== 'function';
}

/** Labels a policy reference for a refusal message. */
function policyLabel(store: MetadataStore, policy: Constructor | PolicyDefinition): string {
  const name = policyName(store, policy);
  if (name !== undefined) {
    return JSON.stringify(name);
  }
  return typeof policy === 'function' ? `${className(policy)} (no @Policy)` : '[unnamed policy]';
}

/**
 * Builds one `@RequirePolicy` enforcing middleware: `501` while no policy service is
 * registered (re-resolved per request, like the guards), `401`/`403` on a
 * denial, `next()` when allowed. A target extractor's throw propagates.
 *
 * @param name - The policy name
 * @param ability - The ability name
 * @param target - The target value or extractor, if any
 * @param anonymous - Whether the registered ability is anonymous (for the brand)
 * @returns The branded middleware
 */
export function createPolicyMiddleware(
  name: string,
  ability: string,
  target: unknown,
  anonymous: boolean,
): MiddlewareFunction {
  const middleware = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    if (!ctx.services.has(CAPABILITIES.AUTHORIZATION_POLICIES)) {
      respondWithAuthorizationFailure(ctx, 'not-configured');
      return;
    }
    const user = ctx.request.user ?? null;
    // Refuse an anonymous request to an ability that needs a principal BEFORE
    // the extractor runs (audit F1) — the same order AuthPlugin's
    // `requirePolicy` uses, so the two cannot disagree.
    if (user === null && !anonymous) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }
    const service = ctx.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    const resolved = typeof target === 'function'
      ? await (target as (ctx: IRequestContext) => unknown)(ctx)
      : target;
    if (!(await service.can(user, name, ability, resolved))) {
      respondWithAuthorizationFailure(
        ctx,
        user === null ? 'authentication-required' : 'insufficient-privileges',
      );
      return;
    }
    await next();
  };
  return withSecurityMetadata(middleware, { authenticated: !anonymous });
}

/**
 * Validates a route's `@RequirePolicy` requirements against the registry and appends
 * their middleware, top to bottom.
 *
 * @param store - The metadata store
 * @param label - The route label for refusals (`Route GET /x (C.m)`)
 * @param requirements - The route's `@RequirePolicy` requirements
 * @param middleware - The route's middleware chain, appended to
 * @param service - The registration-time policy service, if any
 * @returns Whether any appended requirement requires a signed-in principal
 * @throws {Error} When no policy service is registered, or a requirement
 *   names an unregistered policy or ability
 */
export function appendPolicyMiddleware(
  store: MetadataStore,
  label: string,
  requirements: readonly PolicyRequirement[],
  middleware: MiddlewareFunction[],
  service: IAuthorizationPolicyService | undefined,
): boolean {
  if (requirements.length === 0) {
    return false;
  }
  if (service === undefined) {
    throw new Error(
      `${label} is decorated with @RequirePolicy, but no CAPABILITIES.AUTHORIZATION_POLICIES provider is ` +
        'registered. Register AuthPlugin from @setu-ts/auth-plugin.',
    );
  }
  let authenticated = false;
  for (const requirement of requirements) {
    const name = policyName(store, requirement.policy);
    const info = name === undefined ? undefined : service.describe(name, requirement.ability);
    if (name === undefined || info === undefined) {
      throw new Error(
        `${label} is decorated with @RequirePolicy(${policyLabel(store, requirement.policy)}, ` +
          `${JSON.stringify(requirement.ability)}), but no such policy ability is registered. ` +
          'Register the policy through AuthPlugin({ policies }) or DecoratorPlugin({ policies }).',
      );
    }
    // The same refusal AuthPlugin's startup scan applies to `requirePolicy`
    // (audit F4): a referenced policy that does not declare this ability, or
    // declares it differently on `anonymous`, is a DIFFERENT policy sharing the
    // registered one's name — evaluating the registered one silently would
    // enforce rules the route's author never wrote.
    if (declaredAnonymous(store, requirement.policy, requirement.ability) !== info.anonymous) {
      throw new Error(
        `${label} is decorated with @RequirePolicy(${policyLabel(store, requirement.policy)}, ` +
          `${JSON.stringify(requirement.ability)}), but the registered ` +
          `${JSON.stringify(name)} policy declares that ability differently — a different policy ` +
          'is registered under the same name.',
      );
    }
    authenticated ||= !info.anonymous;
    middleware.push(
      createPolicyMiddleware(name, requirement.ability, requirement.target, info.anonymous),
    );
  }
  return authenticated;
}
