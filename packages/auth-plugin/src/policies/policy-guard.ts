/**
 * The `requirePolicy` route guard and the brand AuthPlugin's startup scan
 * reads off it.
 *
 * @module
 */
import {
  CAPABILITIES,
  respondWithAuthorizationFailure,
  withSecurityMetadata,
} from '@setu-ts/common';
import type {
  IAuthorizationPolicyService,
  IRequestContext,
  MiddlewareFunction,
  PolicyDefinition,
  PolicyTarget,
} from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import { isAnonymousAbility } from './define-policy.ts';

/**
 * Brand key carried by every `requirePolicy` middleware.
 *
 * In the process-global registry (`Symbol.for`) so a scan by one copy of this
 * package recognises a guard built by another copy in the same process — the
 * `SECURITY_METADATA` precedent.
 */
const POLICY_GUARD: unique symbol = Symbol.for('setu.auth.policy-guard');

/**
 * What a policy guard names: read by the startup scan.
 *
 * Internal: not exported from the package barrel.
 */
export interface PolicyGuardBrand {
  /** The policy name the guard evaluates. */
  readonly policy: string;
  /** The ability name the guard evaluates. */
  readonly ability: string;
  /** Whether the guard's policy object declared the ability anonymous. */
  readonly anonymous: boolean;
}

/** Labels a value for an error message without converting it (`String` can throw). */
function label(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value : `[${typeof value}]`);
}

/**
 * Reads the brand a `requirePolicy` middleware carries.
 *
 * Internal: not exported from the package barrel.
 *
 * @param middleware - Any route middleware
 * @returns The brand, or `undefined` when the middleware is not a policy guard
 */
export function policyGuardOf(middleware: MiddlewareFunction): PolicyGuardBrand | undefined {
  const value = (middleware as MiddlewareFunction & { readonly [POLICY_GUARD]?: unknown })[
    POLICY_GUARD
  ];
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const brand = value as {
    readonly policy?: unknown;
    readonly ability?: unknown;
    readonly anonymous?: unknown;
  };
  return typeof brand.policy === 'string' && typeof brand.ability === 'string' &&
      typeof brand.anonymous === 'boolean'
    ? { policy: brand.policy, ability: brand.ability, anonymous: brand.anonymous }
    : undefined;
}

/**
 * Guard that requires a policy ability. Returns `501` when no authorization
 * policy service is registered, `401` when the ability denies an anonymous
 * request, `403` when it denies a signed-in principal; otherwise calls
 * `next()`. On every refusal the handler and later middleware do not run.
 *
 * The policy is evaluated BY NAME through the registered
 * `IAuthorizationPolicyService`, so a replacement provider serves the guard.
 * AuthPlugin refuses to start when a route's guard names a policy or ability
 * that is not registered — or whose registered ability disagrees with this
 * object on `anonymous`, which is how a different policy registered under the
 * same name is caught. Not scanned: a route added after `start()`, and a
 * guard added as global middleware; an unknown name there rejects per request
 * (fail closed).
 *
 * A target extractor's throw propagates unchanged, so `errorHandler` answers
 * a database outage `503` rather than a misleading `403`; the handler never
 * runs.
 *
 * @param policy - The policy object (from `definePolicy`)
 * @param ability - One of the policy's ability names
 * @param target - A fixed target, or an extractor called per request
 * @returns Middleware function, branded for OpenAPI `deriveSecurity` and for
 *   the startup scan
 * @throws {AuthPluginConfigurationError} When the ability is not one of the
 *   policy object's own abilities
 * @example
 * ```typescript
 * app.router.patch('/posts/:id', {
 *   middleware: [requirePolicy(postPolicy, 'update', (ctx) => posts.find(ctx.params.id))],
 *   handler,
 * });
 * ```
 * @since 0.9.0
 */
export function requirePolicy<A extends string, T>(
  policy: PolicyDefinition<A, T>,
  ability: A,
  target?: PolicyTarget<T>,
): MiddlewareFunction {
  const name = policy.name;
  const abilities = policy.abilities as Readonly<Record<string, unknown>>;
  if (
    typeof name !== 'string' || typeof ability !== 'string' || !Object.hasOwn(abilities, ability)
  ) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: requirePolicy names ability ${label(ability)} that policy ${label(name)} ` +
        'does not declare',
    );
  }
  const anonymous = isAnonymousAbility(abilities[ability] as never);

  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    if (!ctx.services.has(CAPABILITIES.AUTHORIZATION_POLICIES)) {
      respondWithAuthorizationFailure(ctx, 'not-configured');
      return;
    }
    const service = ctx.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    const resolved = typeof target === 'function'
      ? await (target as (ctx: IRequestContext) => T | undefined | Promise<T | undefined>)(ctx)
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

  Object.defineProperty(guard, POLICY_GUARD, {
    value: Object.freeze({ policy: name, ability, anonymous }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return withSecurityMetadata(guard, { authenticated: !anonymous });
}
