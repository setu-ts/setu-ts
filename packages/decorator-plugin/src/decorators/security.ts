/**
 * Security decorators — declare authorization requirements and extract the
 * authenticated principal.
 *
 * Security metadata is stored but NOT enforced by this plugin; enforcement is
 * the responsibility of guard middleware registered by the auth plugin. The
 * metadata (roles, permissions, `@Public`) is available on the route for any
 * registered guard to read.
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
 * @param roles - One or more role names
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function Roles(...roles: string[]): SetuClassOrMethodDecorator {
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
 * @param permissions - One or more permission names
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function Permissions(...permissions: string[]): SetuClassOrMethodDecorator {
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

/**
 * Marks a route as public — authentication and authorization are bypassed.
 * Takes precedence over `@Roles`/`@Permissions` on the same target.
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
