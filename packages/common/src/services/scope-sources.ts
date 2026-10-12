/**
 * Where a scoped check's scope comes from.
 *
 * A {@linkcode ScopeSource} is a fixed scope, `null` (global grants only), or
 * a function reading the request. A function answering `undefined` reports
 * that no scope could be resolved — the check then DENIES; it never falls back
 * to "any scope".
 *
 * @module
 */

import type { IRequestContext } from '../http.ts';
import { isScopeType, MAX_SCOPE_ID_LENGTH } from './scoped-authorization.ts';
import type { ScopeRef } from './scoped-authorization.ts';

/**
 * The scope of a scoped guard or decorator: a fixed {@linkcode ScopeRef},
 * `null` for global grants only, or a function reading the request.
 *
 * A function answering `undefined` (no tenant resolved, a missing route
 * parameter) leaves the scope UNRESOLVED, and the check denies.
 *
 * @since 0.9.0
 */
export type ScopeSource =
  | ScopeRef
  | null
  | ((ctx: IRequestContext) => ScopeRef | null | undefined | Promise<ScopeRef | null | undefined>);

/**
 * Builds a scope from a request-supplied identifier, or `undefined` when it is
 * missing, empty or too long — a refused id is never truncated.
 */
function toScope(type: string, id: unknown): ScopeRef | undefined {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SCOPE_ID_LENGTH) {
    return undefined;
  }
  return { type, id };
}

/**
 * Refuses an illegal scope type at construction, so a typo fails at startup.
 */
function assertScopeType(type: unknown, factory: string): asserts type is string {
  if (!isScopeType(type)) {
    throw new TypeError(
      `${factory}: the scope type must be lowercase kebab-case, received ${
        JSON.stringify(typeof type === 'string' ? type : `[${typeof type}]`)
      }`,
    );
  }
}

/**
 * The scope of the request's resolved tenant (`ctx.request.tenant`, written by
 * the multi-tenancy middleware). Unresolved — so the check denies — when no
 * tenant was resolved. The default scope source of every scoped guard.
 *
 * @param type - The scope type to give the tenant (default `'tenant'`)
 * @returns A scope source
 * @throws {TypeError} When `type` is not lowercase kebab-case
 * @example
 * ```typescript
 * requireScopedPermission('invoices:approve', { scope: scopeFromTenant() });
 * ```
 * @since 0.9.0
 */
export function scopeFromTenant(
  type = 'tenant',
): (ctx: IRequestContext) => ScopeRef | undefined {
  assertScopeType(type, 'scopeFromTenant');
  return (ctx) => toScope(type, ctx.request.tenant?.id);
}

/**
 * The scope named by a route parameter. Unresolved — so the check denies —
 * when the parameter is absent, empty or too long.
 *
 * When the request also has a resolved tenant and `type` is the tenant scope
 * type, a parameter naming a DIFFERENT tenant is refused by the evaluator, so
 * a caller cannot evaluate another tenant's grants by editing the path.
 *
 * @param param - The route parameter name (`orgId` for `/orgs/:orgId`)
 * @param type - The scope type the parameter names
 * @returns A scope source
 * @throws {TypeError} When `param` is empty or `type` is not lowercase kebab-case
 * @example
 * ```typescript
 * requireScopedRole('admin', { scope: scopeFromParam('orgId', 'organisation') });
 * ```
 * @since 0.9.0
 */
export function scopeFromParam(
  param: string,
  type: string,
): (ctx: IRequestContext) => ScopeRef | undefined {
  if (typeof param !== 'string' || param.length === 0) {
    throw new TypeError('scopeFromParam: the parameter name must be a non-empty string');
  }
  assertScopeType(type, 'scopeFromParam');
  return (ctx) => toScope(type, Object.hasOwn(ctx.params, param) ? ctx.params[param] : undefined);
}
