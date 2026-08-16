/**
 * Tenant binding for a session — seal on commit, compare on load.
 *
 * The binding is ordinary session data under a reserved key, so `ISession`
 * gains no member and `common` is not widened. Reading and writing live in
 * one module so the commit path and the load path cannot disagree about the
 * key.
 *
 * @module
 */
import type { ISession } from '@setu-ts/common';

/**
 * The reserved session key holding the tenant id a session was minted under.
 *
 * Reserved by `SessionPlugin({ tenantBinding: true })` (the default): when a
 * tenant is resolved for the request, the id is sealed here on commit.
 * Application code must not read or write this key — `clear()` and
 * `regenerate()` drop it and the next commit re-binds it, which is correct
 * because a regenerated session is a new session and should adopt the current
 * tenant.
 */
export const TENANT_BINDING_KEY = '__setu_tenant';

/**
 * Reads the tenant id a session is bound to, or `undefined` when unbound.
 *
 * @param session - The session to read
 * @returns The bound tenant id, or `undefined`
 */
export function readTenantBinding(session: ISession): string | undefined {
  const value = session.get(TENANT_BINDING_KEY);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Seals the given tenant id into the session under the reserved key.
 *
 * @param session - The session to bind
 * @param tenantId - The tenant id to seal
 */
export function sealTenantBinding(session: ISession, tenantId: string): void {
  session.set(TENANT_BINDING_KEY, tenantId);
}
