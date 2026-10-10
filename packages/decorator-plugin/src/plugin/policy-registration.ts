/**
 * Class-form policy registration and `@Can` enforcement (M110a §3.11).
 *
 * This package may not import AuthPlugin (AI_GUIDELINES §2.2), so `@Can`
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

/** Labels a policy reference for a refusal message. */
function policyLabel(store: MetadataStore, policy: Constructor | PolicyDefinition): string {
  const name = policyName(store, policy);
  if (name !== undefined) {
    return JSON.stringify(name);
  }
  return typeof policy === 'function' ? `${className(policy)} (no @Policy)` : '[unnamed policy]';
}

/**
 * Builds one `@Can` enforcing middleware: `501` while no policy service is
 * registered (re-resolved per request, like the guards), `401`/`403` on a
 * denial, `next()` when allowed. A target extractor's throw propagates.
 *
 * @param name - The policy name
 * @param ability - The ability name
 * @param target - The target value or extractor, if any
 * @param anonymous - Whether the registered ability is anonymous (for the brand)
 * @returns The branded middleware
 */
export function createCanMiddleware(
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
    const service = ctx.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    const resolved = typeof target === 'function'
      ? await (target as (ctx: IRequestContext) => unknown)(ctx)
      : target;
    const user = ctx.request.user ?? null;
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
 * Validates a route's `@Can` requirements against the registry and appends
 * their middleware, top to bottom.
 *
 * @param store - The metadata store
 * @param label - The route label for refusals (`Route GET /x (C.m)`)
 * @param requirements - The route's `@Can` requirements
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
      `${label} is decorated with @Can, but no CAPABILITIES.AUTHORIZATION_POLICIES provider is ` +
        'registered. Register AuthPlugin from @setu-ts/auth-plugin.',
    );
  }
  let authenticated = false;
  for (const requirement of requirements) {
    const name = policyName(store, requirement.policy);
    const info = name === undefined ? undefined : service.describe(name, requirement.ability);
    if (name === undefined || info === undefined) {
      throw new Error(
        `${label} is decorated with @Can(${policyLabel(store, requirement.policy)}, ` +
          `${JSON.stringify(requirement.ability)}), but no such policy ability is registered. ` +
          'Register the policy through AuthPlugin({ policies }) or DecoratorPlugin({ policies }).',
      );
    }
    authenticated ||= !info.anonymous;
    middleware.push(
      createCanMiddleware(name, requirement.ability, requirement.target, info.anonymous),
    );
  }
  return authenticated;
}
