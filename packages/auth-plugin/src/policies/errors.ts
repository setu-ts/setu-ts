/**
 * The two rejections an authorization policy evaluation can produce.
 *
 * @module
 */
import { authorizationFailureInit, withHttpStatusHint } from '@setu-ts/common';

/**
 * Why a policy denied: no principal was signed in (`401`), or the signed-in
 * principal was refused (`403`).
 *
 * @since 0.9.0
 */
export type PolicyDenial = 'authentication-required' | 'insufficient-privileges';

/**
 * Rejection of `IAuthorizationPolicyService.authorize` when the ability is
 * denied.
 *
 * It carries an HTTP status hint — `401` for {@linkcode PolicyDenial}
 * `authentication-required`, `403` otherwise — whose title and detail are the
 * ones the authorization guards write, so an application's `errorHandler`
 * answers a thrown refusal with the SAME body a guard's refusal gets. Without
 * `errorHandler` the kernel's fallback answers a masked `500`, as it does for
 * every other hinted error. The message names the policy and the ability; it
 * is logged, never served.
 *
 * @example
 * ```typescript
 * try {
 *   await policies.authorize(user, postPolicy, 'update', post);
 * } catch (error) {
 *   if (error instanceof AuthorizationDeniedError && error.failure === 'insufficient-privileges') {
 *     // a signed-in caller lacked the ability
 *   }
 *   throw error;
 * }
 * ```
 * @since 0.9.0
 */
export class AuthorizationDeniedError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'AuthorizationDeniedError';
  /** Why the ability was denied. */
  readonly failure: PolicyDenial;
  /** The policy that was evaluated. */
  readonly policy: string;
  /** The ability that was denied. */
  readonly ability: string;

  /**
   * Creates the denial rejection and brands it with its HTTP status hint.
   *
   * @param failure - Why the ability was denied
   * @param policy - The policy name
   * @param ability - The ability name
   */
  constructor(failure: PolicyDenial, policy: string, ability: string) {
    super(
      `auth-plugin: authorization denied by policy ${JSON.stringify(policy)} for ability ` +
        `${JSON.stringify(ability)} (${failure})`,
    );
    this.failure = failure;
    this.policy = policy;
    this.ability = ability;
    withHttpStatusHint(this, authorizationFailureInit(failure));
  }
}

/**
 * Rejection of every authorization policy entry point when the policy, or the
 * ability within it, is not registered.
 *
 * It is a programming error rather than a caller fault, so it carries no
 * status hint: under `errorHandler` it answers a masked `500`. A route guard
 * or decorator naming an unknown policy is refused at startup, before any
 * request; this rejection is what an imperative call — or a route added after
 * `start()` — meets instead.
 *
 * @since 0.9.0
 */
export class UnknownPolicyError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnknownPolicyError';
  /** The policy name that was looked up. */
  readonly policy: string;
  /** The ability name, when the policy exists but the ability does not. */
  readonly ability: string | undefined;

  /**
   * Creates the unknown-policy rejection.
   *
   * @param policy - The policy name that was looked up
   * @param ability - The missing ability, when the policy itself exists
   */
  constructor(policy: string, ability?: string) {
    super(
      ability === undefined
        ? `auth-plugin: no authorization policy named ${JSON.stringify(policy)} is registered`
        : `auth-plugin: authorization policy ${JSON.stringify(policy)} has no ability ` +
          `${JSON.stringify(ability)}`,
    );
    this.policy = policy;
    this.ability = ability;
  }
}
