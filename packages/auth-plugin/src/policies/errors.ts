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
 * The longest policy or ability name an {@linkcode UnknownPolicyError} carries.
 * Registered names are developer-chosen and short; a name longer than this
 * reached an imperative call from somewhere else — possibly a request — and is
 * truncated so one request cannot write an arbitrarily large log record
 * (audit F5: a 200,000-character ability produced a 602,065-character line,
 * since the message, the stack and the field each carried it).
 */
const MAX_NAME_LENGTH = 128;

/** A name cut to {@linkcode MAX_NAME_LENGTH}, and how much was removed. */
interface BoundedName {
  readonly value: string;
  readonly dropped: number;
}

/** Truncates a name to the bound, recording how many characters were removed. */
function bound(name: string): BoundedName {
  return name.length <= MAX_NAME_LENGTH
    ? { value: name, dropped: 0 }
    : { value: name.slice(0, MAX_NAME_LENGTH), dropped: name.length - MAX_NAME_LENGTH };
}

/** Quotes a bounded name for a message, noting a truncation. */
function quote(name: BoundedName): string {
  return name.dropped === 0
    ? JSON.stringify(name.value)
    : `${JSON.stringify(name.value)}(+${name.dropped} more)`;
}

/**
 * Rejection of every authorization policy entry point when the policy, or the
 * ability within it, is not registered.
 *
 * It is a programming error rather than a caller fault, so it carries no
 * status hint: under `errorHandler` it answers a masked `500`. A route guard
 * or decorator naming an unknown policy is refused at startup, before any
 * request; this rejection is what an imperative call — or a route added after
 * `start()` — meets instead. Names longer than 128 characters are truncated in
 * the message and in the fields, with the number of removed characters noted.
 *
 * @since 0.9.0
 */
export class UnknownPolicyError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnknownPolicyError';
  /** The policy name that was looked up (at most 128 characters). */
  readonly policy: string;
  /** The ability name, when the policy exists but the ability does not (at most 128 characters). */
  readonly ability: string | undefined;

  /**
   * Creates the unknown-policy rejection.
   *
   * @param policy - The policy name that was looked up
   * @param ability - The missing ability, when the policy itself exists
   */
  constructor(policy: string, ability?: string) {
    const boundedPolicy = bound(policy);
    const boundedAbility = ability === undefined ? undefined : bound(ability);
    super(
      boundedAbility === undefined
        ? `auth-plugin: no authorization policy named ${quote(boundedPolicy)} is registered`
        : `auth-plugin: authorization policy ${quote(boundedPolicy)} has no ability ` +
          quote(boundedAbility),
    );
    this.policy = boundedPolicy.value;
    this.ability = boundedAbility?.value;
  }
}
