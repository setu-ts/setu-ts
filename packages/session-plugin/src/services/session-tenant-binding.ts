/**
 * Tenant binding for a session — seal on commit, compare on load.
 *
 * The binding is ordinary session data under a reserved key, so `ISession`
 * gains no member. The key and the compare live in `common`
 * (`SESSION_TENANT_BINDING_KEY`, `tenantBindingMismatch`) because a second
 * compare site in `multi-tenancy-plugin` must agree with this one byte-for-
 * byte (M101c, V8-7); this module re-exports the key and keeps the seal so
 * the commit path and the load path cannot disagree about the key.
 *
 * @module
 */
import type { ISession } from '@setu-ts/common';
import { SESSION_TENANT_BINDING_KEY } from '@setu-ts/common';

export { SESSION_TENANT_BINDING_KEY };

/**
 * The reserved session key holding the tenant id a session was minted under.
 *
 * Re-exported from `@setu-ts/common`, where it is defined so the
 * multi-tenancy plugin's tenant-side compare reads the same key. Reserved by
 * `SessionPlugin({ tenantBinding: true })` (the default): when a tenant is
 * resolved for the request, the id is sealed here on commit. Application code
 * must not read or write this key — `clear()` and `regenerate()` drop it and
 * the next commit re-binds it, which is correct because a regenerated session
 * is a new session and should adopt the current tenant.
 *
 * @since 0.2.0
 */
export const TENANT_BINDING_KEY = SESSION_TENANT_BINDING_KEY;

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
