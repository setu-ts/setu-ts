/**
 * Class-form authorization policies and the `@Can` route requirement (M110a).
 *
 * `@Policy(name)` marks a class as a policy; `@Ability()` marks each method
 * that is an ability; an optional `before` method is the policy's `before`
 * hook. List the class in `DecoratorPlugin({ policies })` and the plugin
 * constructs it — with constructor injection, like any controller — and
 * registers it with the authorization policy service AuthPlugin provides.
 *
 * `@Can(policy, ability, target?)` requires an ability on a route. It accepts
 * a `@Policy` class or a `definePolicy` definition, and is evaluated through
 * the same service as AuthPlugin's `requirePolicy` guard.
 *
 * @module
 * @since 0.9.0
 */
import type { Constructor, PolicyDefinition, PolicyTarget } from '@setu-ts/common';
import { classDecorator, methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassDecorator, SetuMethodDecorator } from '../metadata/context-bridge.ts';

/**
 * Options for {@linkcode Ability}.
 *
 * @since 0.9.0
 */
export interface AbilityOptions {
  /**
   * Evaluate the ability for anonymous principals too: the method is then
   * called with `null` when no principal is signed in. Default `false` — an
   * anonymous request is refused `401` before the method runs.
   */
  readonly anonymous?: boolean;
}

/**
 * The method names of a policy class — the abilities `@Can` may name.
 *
 * The type cannot tell an `@Ability` method from an ordinary one, so naming an
 * ordinary method compiles and is refused at `register()`.
 *
 * @typeParam C - The policy class
 * @since 0.9.0
 */
export type PolicyClassAbility<C extends Constructor> =
  & {
    [K in keyof InstanceType<C>]: InstanceType<C>[K] extends (...args: never[]) => unknown ? K
      : never;
  }[keyof InstanceType<C>]
  & string;

/**
 * The target type a policy class's ability method receives, read off its
 * second parameter (`undefined` stripped, since a missing target is always
 * permitted).
 *
 * @typeParam C - The policy class
 * @typeParam K - The ability method name
 * @since 0.9.0
 */
export type PolicyClassTarget<C extends Constructor, K extends keyof InstanceType<C>> =
  InstanceType<C>[K] extends (principal: never, target: infer T) => unknown ? Exclude<T, undefined>
    : unknown;

/**
 * Marks a class as an authorization policy named `name`.
 *
 * @param name - The policy name, lowercase kebab-case and unique in the
 *   application (validated when `DecoratorPlugin` registers the class)
 * @returns A standard class decorator
 * @example
 * ```typescript
 * @Policy('post')
 * @Inject('posts')
 * class PostPolicy {
 *   constructor(private readonly posts: PostRepository) {}
 *
 *   before(principal: IPrincipal): boolean | undefined {
 *     return principal.roles?.includes('admin') ? true : undefined;
 *   }
 *
 *   @Ability()
 *   update(principal: IPrincipal, post: Post | undefined): boolean {
 *     return post?.authorId === principal.id;
 *   }
 *
 *   @Ability({ anonymous: true })
 *   read(_principal: IPrincipal | null, post: Post | undefined): boolean {
 *     return post?.published === true;
 *   }
 * }
 * ```
 * @since 0.9.0
 */
export function Policy(name: string): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.setPolicyName(target, name);
  });
}

/**
 * Marks a method of a `@Policy` class as an ability.
 *
 * The method receives `(principal, target)` and allows only by returning
 * `true` (or a promise of `true`); any other value, a throw, or a rejection
 * denies. A method named `before` is the policy's `before` hook, not an
 * ability, and is refused if marked.
 *
 * @param options - Whether the ability is evaluated for anonymous principals
 * @returns A standard method decorator
 * @since 0.9.0
 */
export function Ability(options?: AbilityOptions): SetuMethodDecorator {
  const anonymous = options?.anonymous === true;
  return methodDecorator((store, target, method) => {
    store.addPolicyAbility(target, method, anonymous);
  });
}

/**
 * Requires a policy ability on a route.
 *
 * Refused at `register()` when no authorization policy service is registered
 * (register `AuthPlugin`), or when the policy or ability is not registered.
 * Per request: `401` when the ability denies an anonymous request, `403` when
 * it denies a signed-in principal, otherwise the route continues. Repeatable:
 * every `@Can` on a route must allow, evaluated top to bottom. Runs after
 * guards and `@Roles`/`@Permissions`, and before interceptors, middleware and
 * validation — so a target extractor reading the body sees the UNVALIDATED
 * body; prefer route parameters.
 *
 * @param policy - A `@Policy` class
 * @param ability - One of its ability methods
 * @param target - A fixed target, or an extractor called per request
 * @returns A standard method decorator
 * @example
 * ```typescript
 * @Patch('/:id')
 * @Can(PostPolicy, 'update', (ctx) => posts.find(ctx.params.id))
 * update() { … }
 * ```
 * @since 0.9.0
 */
export function Can<C extends Constructor, K extends PolicyClassAbility<C>>(
  policy: C,
  ability: K,
  target?: PolicyTarget<PolicyClassTarget<C, K>>,
): SetuMethodDecorator;
/**
 * Requires an ability of a `definePolicy` definition on a route.
 *
 * @param policy - A policy definition
 * @param ability - One of its ability names
 * @param target - A fixed target, or an extractor called per request
 * @returns A standard method decorator
 * @since 0.9.0
 */
export function Can<A extends string, T>(
  policy: PolicyDefinition<A, T>,
  ability: A,
  target?: PolicyTarget<T>,
): SetuMethodDecorator;
export function Can(
  policy: Constructor | PolicyDefinition,
  ability: string,
  target?: unknown,
): SetuMethodDecorator {
  const requirement = target === undefined ? { policy, ability } : { policy, ability, target };
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      // Decorators apply bottom-up: prepending leaves the list top to bottom.
      meta.policies = [requirement, ...(meta.policies ?? [])];
    });
  });
}
