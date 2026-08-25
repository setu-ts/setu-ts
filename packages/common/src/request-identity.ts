/**
 * Single-write guard for the two mutable identity fields on
 * {@linkcode IRequest} — `user` and `tenant`.
 *
 * **This is not a security boundary.** Anything already running in the
 * process can re-import this module and call {@linkcode replacePrincipal},
 * or monkey-patch the prototypes these accessors sit on. The guard exists as
 * defense-in-depth against ACCIDENTS: a typo, a middleware-ordering mistake,
 * or a third-party stage that overwrites an authenticated principal long
 * after authentication ran. It turns that into a loud failure at the moment
 * it happens instead of a silent behaviour change several stages later.
 *
 * Nor does it stop a forged principal written BEFORE authentication: that is
 * the first write, and the first write is always allowed. What it closes is
 * the LATE overwrite, and the presence of two independent identity writers in
 * one pipeline.
 *
 * @module
 */
import type { IRequest } from './http.ts';
import type { IPrincipal } from './services/auth.ts';
import type { ITenant } from './services/tenancy.ts';

/**
 * Backing slots. Symbol-keyed so they are invisible to `Object.keys`,
 * `JSON.stringify`, spread and every enumeration the framework performs — a
 * sealed request serializes exactly as an unsealed one does.
 */
const USER_SLOT = Symbol('setu.request.user');
const USER_WRITTEN = Symbol('setu.request.userWritten');
const TENANT_SLOT = Symbol('setu.request.tenant');
const TENANT_WRITTEN = Symbol('setu.request.tenantWritten');

/** The symbol-keyed view of a sealed request, used only inside this module. */
type IdentitySlots = Record<symbol, unknown>;

/**
 * Builds the error a second implicit write raises.
 *
 * @param field - The field that was written twice
 * @returns The error to throw
 */
function secondWriteError(field: 'user' | 'tenant'): Error {
  const replacer = field === 'user' ? 'replacePrincipal' : 'replaceTenant';
  return new Error(
    `ctx.request.${field} has already been set for this request and accepts one write. ` +
      `Something is assigning it a second time — usually two middleware stages writing the ` +
      `same identity. Compute the final value before the single assignment, or call ` +
      `${replacer}(ctx.request, value) from '@setu-ts/common' to replace it deliberately.`,
  );
}

/**
 * Shared accessor descriptors. Module-level constants rather than
 * per-request closures: measured at 298 ns/request against 699 ns for the
 * closure form, and they allocate nothing per request beyond the slots
 * themselves (AI_GUIDELINES §14.1).
 */
const IDENTITY_DESCRIPTORS: PropertyDescriptorMap = {
  user: {
    enumerable: true,
    configurable: true,
    get(this: IdentitySlots): IPrincipal | undefined {
      return this[USER_SLOT] as IPrincipal | undefined;
    },
    set(this: IdentitySlots, value: IPrincipal | undefined): void {
      if (this[USER_WRITTEN] === true) {
        throw secondWriteError('user');
      }
      this[USER_WRITTEN] = true;
      this[USER_SLOT] = value;
    },
  },
  tenant: {
    enumerable: true,
    configurable: true,
    get(this: IdentitySlots): ITenant | undefined {
      return this[TENANT_SLOT] as ITenant | undefined;
    },
    set(this: IdentitySlots, value: ITenant | undefined): void {
      if (this[TENANT_WRITTEN] === true) {
        throw secondWriteError('tenant');
      }
      this[TENANT_WRITTEN] = true;
      this[TENANT_SLOT] = value;
    },
  },
};

/** Reports whether this module installed the accessor for an identity field. */
function isSealed(request: IRequest, field: 'user' | 'tenant'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(request, field);
  return descriptor?.get === IDENTITY_DESCRIPTORS[field]?.get;
}

/**
 * Installs the single-write guard over `request.user` and `request.tenant`.
 *
 * Called once per request by the kernel's request-context factory — the one
 * funnel every request passes through whatever produced its
 * {@linkcode IRequest} — and by `@setu-ts/testing`'s `createTestContext`, so
 * the test double honours the same contract the kernel enforces.
 *
 * A value already present on the request (a test context seeded with a
 * principal) is migrated into the backing slot and counts as the first write,
 * so a seeded request refuses a further implicit assignment exactly as an
 * authenticated one does. Calling this twice on the same request is a no-op:
 * the second call sees the accessors already installed and leaves the
 * written-flags alone.
 *
 * @param request - The request to guard; mutated in place
 * @example
 * ```typescript
 * sealRequestIdentity(request);
 * request.user = principal;   // ok — first write
 * request.user = other;       // throws
 * ```
 * @since 0.1.0
 */
export function sealRequestIdentity(request: IRequest): void {
  const slots = request as unknown as IdentitySlots;
  if (isSealed(request, 'user')) {
    // Already sealed — re-installing would reset nothing but would re-run the
    // seeding below against slots that are already authoritative.
    return;
  }
  const seededUser = request.user;
  const seededTenant = request.tenant;
  if (seededUser !== undefined) {
    slots[USER_SLOT] = seededUser;
    slots[USER_WRITTEN] = true;
  }
  if (seededTenant !== undefined) {
    slots[TENANT_SLOT] = seededTenant;
    slots[TENANT_WRITTEN] = true;
  }
  Object.defineProperties(request, IDENTITY_DESCRIPTORS);
}

/**
 * Replaces `request.user` deliberately, bypassing the single-write guard.
 *
 * This is the framework's authoritative identity write: `auth-plugin`'s
 * `authMiddleware` calls it, because a global registration plus a route-level
 * one is a supported composition and both runs must be allowed to write. An
 * application performing step-up authentication or impersonation calls it for
 * the same reason — the boundary the guard draws is explicit intent versus
 * implicit assignment, not one write per request.
 *
 * Safe to call on a request that was never sealed.
 *
 * @param request - The request whose principal is being replaced
 * @param principal - The principal to install
 * @example
 * ```typescript
 * // Step-up: upgrade the principal after a second factor is verified.
 * replacePrincipal(ctx.request, { ...ctx.request.user!, roles: elevated });
 * ```
 * @since 0.1.0
 */
export function replacePrincipal(request: IRequest, principal: IPrincipal): void {
  const slots = request as unknown as IdentitySlots;
  if (!isSealed(request, 'user')) {
    request.user = principal;
    return;
  }
  slots[USER_SLOT] = principal;
  slots[USER_WRITTEN] = true;
}

/**
 * Replaces `request.tenant` deliberately, bypassing the single-write guard.
 *
 * `multi-tenancy-plugin`'s `tenantMiddleware` calls it, for the reason
 * {@linkcode replacePrincipal} documents. Safe to call on a request that was
 * never sealed.
 *
 * @param request - The request whose tenant is being replaced
 * @param tenant - The tenant to install
 * @since 0.1.0
 */
export function replaceTenant(request: IRequest, tenant: ITenant): void {
  const slots = request as unknown as IdentitySlots;
  if (!isSealed(request, 'tenant')) {
    request.tenant = tenant;
    return;
  }
  slots[TENANT_SLOT] = tenant;
  slots[TENANT_WRITTEN] = true;
}
