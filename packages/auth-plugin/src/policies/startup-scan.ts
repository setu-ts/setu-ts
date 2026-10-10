/**
 * The startup refusal of a `requirePolicy` guard naming a policy or ability
 * that is not registered.
 *
 * A functional guard is a value the application builds, so no `register()`
 * ever sees it. AuthPlugin runs this from its `onBootstrap` hook instead —
 * after every plugin has registered its routes, and before the server listens
 * — so a misspelled policy fails `start()` rather than the first request.
 *
 * @module
 */
import type { IAuthorizationPolicyService, RouteInfo } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import { policyGuardOf } from './policy-guard.ts';

/**
 * Checks every route's `requirePolicy` guards against the registry.
 *
 * Internal: not exported from the package barrel.
 *
 * A guard is refused when its ability is not registered, or when the
 * registered ability disagrees with the guard's policy object on `anonymous`
 * — the signature of a DIFFERENT policy registered under the same name, which
 * the guard would otherwise evaluate silently. Every problem is reported in
 * one error, so a misconfigured application is fixed in one pass.
 *
 * @param routes - The application's registered routes
 * @param service - The registered policy service
 * @throws {AuthPluginConfigurationError} When any guard names an unregistered
 *   or mismatched policy ability
 */
export function scanPolicyGuards(
  routes: readonly RouteInfo[],
  service: IAuthorizationPolicyService,
): void {
  const problems: string[] = [];
  for (const route of routes) {
    for (const middleware of route.definition.middleware ?? []) {
      const brand = policyGuardOf(middleware);
      if (brand === undefined) {
        continue;
      }
      const where = `route ${route.method} ${route.path} uses requirePolicy(${
        JSON.stringify(brand.policy)
      }, ${JSON.stringify(brand.ability)})`;
      const registered = service.describe(brand.policy, brand.ability);
      if (registered === undefined) {
        problems.push(`${where}, but no such policy ability is registered`);
      } else if (registered.anonymous !== brand.anonymous) {
        problems.push(
          `${where}, but the registered ${JSON.stringify(brand.policy)} policy declares that ` +
            'ability differently — a different policy is registered under the same name',
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: ${problems.join('; ')}. Register the policy through ` +
        'AuthPlugin({ policies }) or DecoratorPlugin({ policies }).',
    );
  }
}
