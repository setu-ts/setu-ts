/**
 * Security decorators — declare authorization requirements and extract the
 * authenticated principal.
 *
 * `@Roles`/`@Permissions` are ENFORCED by `DecoratorPlugin` (unless
 * `enforceRoles: false`): each decorated route gets middleware that checks the
 * declared restriction against the `CAPABILITIES.AUTHORIZATION` service, and
 * a route decorated in an application with no such provider fails closed — it
 * answers `501`, never serving unguarded. `@Public` sets the `isPublic`
 * metadata flag only: it does not exempt a route from a guard.
 *
 * @module
 */
import { classOrMethodDecorator, methodDecorator } from '../metadata/context-bridge.ts';
import type {
  SetuClassOrMethodDecorator,
  SetuMethodDecorator,
} from '../metadata/context-bridge.ts';

/** Metadata key carrying a built-in parameter's kind marker. */
export const PARAMETER_KIND_KEY = 'setu-ts.parameter.kind';

/**
 * Marker identifying the built-in `@Ctx()` decorator, distinguishing it from an
 * application-defined custom parameter that also uses the name `context`.
 *
 * Registered in the process-global symbol registry via `Symbol.for` rather than
 * created with `Symbol()`, so the marker compares equal across two copies of
 * this package sharing one process — an application importing `Ctx` from one
 * copy while a starter runs `DecoratorPlugin` from another. A copy-local
 * identity misses on every read in that arrangement, and because the resolver
 * would then fall through to `undefined`, the handler fails on its first
 * `ctx.` access with no indication why. Same reasoning as `SECURITY_METADATA`
 * in `@setu-ts/common`.
 */
export const CONTEXT_PARAMETER_MARKER: symbol = Symbol.for('@setu-ts/decorator-plugin:context');

/**
 * Metadata attached by `@Ctx()`, carrying {@linkcode CONTEXT_PARAMETER_MARKER}.
 *
 * This is intentionally not re-exported from the package barrel. Recognition is
 * by marker VALUE, never by this object's identity.
 */
export const CONTEXT_PARAMETER_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
  [PARAMETER_KIND_KEY]: CONTEXT_PARAMETER_MARKER,
});

/**
 * Reports whether parameter metadata was attached by the built-in `@Ctx()`,
 * including by a different copy of this package in the same process.
 *
 * @param metadata - Captured parameter metadata, if any
 * @returns `true` when the metadata carries the context marker
 */
export function isContextParameter(metadata?: Readonly<Record<string, unknown>>): boolean {
  return metadata?.[PARAMETER_KIND_KEY] === CONTEXT_PARAMETER_MARKER;
}

/**
 * Requires the authenticated principal to hold any of the given roles. May be
 * applied at the class level (default for all routes) or method level
 * (overrides the class default).
 *
 * Enforced by `DecoratorPlugin` unless `enforceRoles: false`: the route's
 * chain gets middleware that answers `401` without a principal, `403` when
 * the principal holds none of the roles, and — when no authorization provider
 * is registered at all — `501` (fail closed, with a startup warning naming
 * both remedies).
 *
 * @param roles - One or more role names
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function Roles(...roles: string[]): SetuClassOrMethodDecorator {
  assertNonEmptyRestriction('Roles', 'role', roles);
  return classOrMethodDecorator(
    (store, target) => {
      store.mergeController(target, { roles });
    },
    (store, target, handler) => {
      store.mutateMethod(target, handler, (meta) => {
        meta.roles = roles;
      });
    },
  );
}

/**
 * Requires the authenticated principal to hold any of the given permissions.
 * May be applied at the class or method level (method overrides class).
 *
 * Enforced by `DecoratorPlugin` unless `enforceRoles: false`, with the same
 * `401`/`403`/absent-provider-`501` behaviour as `@Roles`. A route carrying
 * both `@Roles` and `@Permissions` requires (any role) AND (any permission).
 *
 * @param permissions - One or more permission names
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function Permissions(...permissions: string[]): SetuClassOrMethodDecorator {
  assertNonEmptyRestriction('Permissions', 'permission', permissions);
  return classOrMethodDecorator(
    (store, target) => {
      store.mergeController(target, { permissions });
    },
    (store, target, handler) => {
      store.mutateMethod(target, handler, (meta) => {
        meta.permissions = permissions;
      });
    },
  );
}

/** Rejects a declaration that cannot name an authorization requirement. */
function assertNonEmptyRestriction(
  decorator: 'Roles' | 'Permissions',
  kind: 'role' | 'permission',
  names: readonly string[],
): void {
  if (names.length === 0) {
    throw new Error(`@${decorator}() requires at least one ${kind}.`);
  }
}

/**
 * Marks an unrestricted route as public in the OpenAPI document: its schema
 * carries `security: []`, so a document-level security requirement does not
 * apply to it.
 *
 * It does NOT exempt a route from a guard or from `@Roles`/`@Permissions`
 * enforcement — those still run and still refuse. When enforcement is enabled,
 * a route carrying a restriction omits the public marker so derived OpenAPI
 * security remains truthful. A route that must be reachable unauthenticated
 * should carry no restriction in the first place.
 *
 * @returns A method decorator
 * @since 0.1.0
 */
export function Public(): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      meta.isPublic = true;
    });
  });
}
