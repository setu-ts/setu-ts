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
import type { Constructor } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';

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
