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
import type { Constructor } from '@setu-ts/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

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
export function Roles(...roles: string[]): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      metadataStore.mergeController(target as unknown as Constructor, { roles });
    } else {
      metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
        meta.roles = roles;
      });
    }
  };
}

/**
 * Requires the authenticated principal to hold any of the given permissions.
 * May be applied at the class or method level (method overrides class).
 *
 * @param permissions - One or more permission names
 * @returns A class or method decorator
 * @since 0.1.0
 */
export function Permissions(...permissions: string[]): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      metadataStore.mergeController(target as unknown as Constructor, { permissions });
    } else {
      metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
        meta.permissions = permissions;
      });
    }
  };
}

/**
 * Injects the authenticated principal (`ctx.request.user`). Resolved by
 * {@linkcode resolveParameters} as a custom parameter of type `'current-user'`.
 *
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function CurrentUser(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'custom',
      customType: 'current-user',
    });
  };
}

/**
 * Injects the active request context. Use it when a decorated handler needs
 * to configure its response or return a streaming response.
 *
 * Resolved by {@linkcode resolveParameters} as a custom parameter of type
 * `'context'`. An internal metadata marker preserves application-defined
 * custom resolvers that also use the `context` name.
 *
 * @returns A parameter decorator
 * @since 0.1.0
 */
export function Ctx(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), {
      index: parameterIndex,
      type: 'custom',
      customType: 'context',
      metadata: CONTEXT_PARAMETER_METADATA,
    });
  };
}

/**
 * Marks a route as public — authentication and authorization are bypassed.
 * Takes precedence over `@Roles`/`@Permissions` on the same target.
 *
 * @returns A method decorator
 * @since 0.1.0
 */
export function Public(): MethodDecorator {
  return (target, propertyKey) => {
    metadataStore.mutateMethod(protoToCtor(target), String(propertyKey), (meta) => {
      meta.isPublic = true;
    });
  };
}
