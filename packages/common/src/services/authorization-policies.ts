/**
 * Authorization policy contracts — an asynchronous, target-aware check,
 * fulfilled by the AuthPlugin under `CAPABILITIES.AUTHORIZATION_POLICIES`.
 *
 * `IAuthorizationService` answers "does this principal hold this role or
 * permission, anywhere" synchronously and has no parameter through which a
 * target can reach a decision. A policy answers "may this principal do this,
 * to this target": each named policy is a set of abilities, each ability an
 * asynchronous check that receives the principal and the target. Attribute
 * rules ("the author of this document", "an approver of this amount") are
 * written as policies; the framework ships no attribute engine.
 *
 * @module
 */

import type { IRequestContext } from '../http.ts';
import type { IPrincipal } from './auth.ts';

/**
 * A check for an ability that requires a signed-in principal.
 *
 * An anonymous request never reaches it: the evaluator denies it first, with
 * the `401`-mapped `authentication-required` failure. Only a literal `true`
 * allows; every other return value — and any throw or rejection — denies.
 *
 * @typeParam T - The target type the policy is written for
 * @since 0.9.0
 */
export type PolicyCheck<T> = (
  principal: IPrincipal,
  target: T | undefined,
) => boolean | Promise<boolean>;

/**
 * A check for an ability that opted in to anonymous principals: it is called
 * with `null` when no principal is signed in.
 *
 * @typeParam T - The target type the policy is written for
 * @since 0.9.0
 */
export type AnonymousPolicyCheck<T> = (
  principal: IPrincipal | null,
  target: T | undefined,
) => boolean | Promise<boolean>;

/**
 * One ability of a policy: a plain {@linkcode PolicyCheck}, or an object that
 * opts the ability in to anonymous principals.
 *
 * Opting in is explicit and per ability so the default is fail-closed, and so
 * a documentation generator can tell a route that requires authentication from
 * one that does not.
 *
 * @typeParam T - The target type the policy is written for
 * @since 0.9.0
 */
export type PolicyAbility<T> = PolicyCheck<T> | {
  /** Marks the ability as evaluated for anonymous principals too. */
  readonly anonymous: true;
  /** The check, receiving `null` for an anonymous principal. */
  readonly check: AnonymousPolicyCheck<T>;
};

/**
 * A named authorization policy: a set of abilities over one target type, plus
 * an optional `before` hook that may allow or deny every ability of the
 * policy (an administrator bypass, a suspended-account block).
 *
 * The bare `PolicyDefinition` — `A = string`, `T = never` — is the type-erased
 * form a registry stores. Two typing choices make every typed policy
 * assignable to it under `strictFunctionTypes`: `before` is a METHOD
 * signature, which TypeScript checks bivariantly, and the target defaults to
 * `never`, so a check written for `Post` is assignable to a check over
 * `never`.
 *
 * @typeParam A - The ability names
 * @typeParam T - The target type the abilities receive
 * @example
 * ```typescript
 * const postPolicy: PolicyDefinition<'update' | 'read', Post> = {
 *   name: 'post',
 *   abilities: {
 *     update: (principal, post) => post?.authorId === principal.id,
 *     read: { anonymous: true, check: (_principal, post) => post?.published === true },
 *   },
 *   before(principal) {
 *     return principal.roles?.includes('admin') === true ? true : undefined;
 *   },
 * };
 * ```
 * @since 0.9.0
 */
export interface PolicyDefinition<A extends string = string, T = never> {
  /**
   * The policy's name — lowercase kebab-case (`^[a-z][a-z0-9-]*$`), unique
   * within one application. It is the policy's identity: every entry point
   * looks a policy up by this name.
   */
  readonly name: string;
  /** The abilities, keyed by ability name. `before` is not a legal ability name. */
  readonly abilities: Readonly<Record<A, PolicyAbility<T>>>;
  /**
   * Runs before the ability's check, for a signed-in principal only.
   *
   * Return `true` to allow, `undefined` to fall through to the ability's
   * check, anything else — `false`, `null`, a non-boolean — to deny. A throw
   * or rejection denies.
   *
   * @param principal - The signed-in principal
   * @param ability - The ability being evaluated
   * @param target - The target, when one was supplied
   * @returns `true`, `undefined`, or a deny
   */
  before?(
    principal: IPrincipal,
    ability: A,
    target: T | undefined,
  ): boolean | undefined | Promise<boolean | undefined>;
}

/**
 * A reference to a policy: its name, or the definition itself (which is
 * looked up by its `name`).
 *
 * @typeParam A - The ability names
 * @typeParam T - The target type
 * @since 0.9.0
 */
export type PolicyRef<A extends string, T> = string | PolicyDefinition<A, T>;

/**
 * The target a route-level policy check evaluates against: a fixed value, or
 * an extractor called per request — reading a route parameter, or loading the
 * record. A FUNCTION is always treated as an extractor; a policy whose target
 * is itself a function wraps it. An extractor may answer `undefined` — a
 * record that was not found — which the check receives as it receives an
 * omitted target, since every check's target is already `T | undefined`.
 *
 * Shared by AuthPlugin's `requirePolicy` and DecoratorPlugin's `@RequirePolicy`, so the
 * two entry points accept the same targets.
 *
 * @typeParam T - The policy's target type
 * @since 0.9.0
 */
export type PolicyTarget<T> =
  | T
  | ((ctx: IRequestContext) => T | undefined | Promise<T | undefined>);

/**
 * What a registry reports about one registered ability.
 *
 * @since 0.9.0
 */
export interface PolicyAbilityInfo {
  /** `true` when the ability is evaluated for anonymous principals too. */
  readonly anonymous: boolean;
}

/**
 * The authorization policy service — one evaluator behind every entry point
 * (route guard, decorator, imperative check), so they cannot disagree.
 *
 * The evaluation semantics are fixed rather than configurable:
 *
 * - an unknown policy or ability REJECTS, naming it — never a deny;
 * - an anonymous principal is denied (`401`) unless the ability opted in;
 * - for a signed-in principal, `before` runs first: `true` allows,
 *   `undefined` falls through, anything else denies;
 * - the check allows only on a literal `true`;
 * - a throw or rejection from `before` or the check DENIES, and is reported
 *   to the logger — it never answers `200`.
 *
 * @example
 * ```typescript
 * const policies = ctx.services.get<IAuthorizationPolicyService>(
 *   CAPABILITIES.AUTHORIZATION_POLICIES,
 * );
 * if (await policies.can(ctx.request.user ?? null, postPolicy, 'update', post)) {
 *   // render the edit button
 * }
 * await policies.authorize(ctx.request.user ?? null, postPolicy, 'update', post);
 * ```
 * @since 0.9.0
 */
export interface IAuthorizationPolicyService {
  /**
   * Evaluates one ability.
   *
   * @param principal - The principal, or `null` when anonymous
   * @param policy - The policy name, or its definition
   * @param ability - The ability name
   * @param target - The target the check receives
   * @returns `true` when allowed
   * @throws {Error} — as a REJECTION: when the policy or ability is unknown
   */
  can<A extends string, T>(
    principal: IPrincipal | null,
    policy: PolicyRef<A, T>,
    ability: A,
    target?: T,
  ): Promise<boolean>;
  /**
   * Evaluates one ability and rejects when it is denied.
   *
   * The deny rejection carries an HTTP status hint (`401` for an anonymous
   * principal, `403` otherwise), so an application's error handler answers it
   * with the same body the authorization guards write.
   *
   * @param principal - The principal, or `null` when anonymous
   * @param policy - The policy name, or its definition
   * @param ability - The ability name
   * @param target - The target the check receives
   * @returns Resolves when allowed
   * @throws {Error} — as a REJECTION: when denied, or when the policy or
   * ability is unknown
   */
  authorize<A extends string, T>(
    principal: IPrincipal | null,
    policy: PolicyRef<A, T>,
    ability: A,
    target?: T,
  ): Promise<void>;
  /**
   * Reports a registered ability without evaluating anything.
   *
   * @param policy - The policy name
   * @param ability - The ability name
   * @returns The ability's description, or `undefined` when either is unknown
   */
  describe(policy: string, ability: string): PolicyAbilityInfo | undefined;
  /**
   * Registers a policy. Refused once the application has started.
   *
   * @param policy - The definition to register
   * @throws {Error} When the definition is malformed, its name is already
   * registered, or the registry is sealed
   */
  define(policy: PolicyDefinition): void;
}
