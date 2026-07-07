/**
 * Custom decorator factories — let consumers create their own decorators
 * that integrate with the framework.
 *
 * {@linkcode createDecorator} stores class/method metadata replayed against
 * handlers registered via `ctx.decorators.register(name, handler)` (collected
 * under `CAPABILITIES.DECORATOR_HANDLER`). {@linkcode createParameterDecorator}
 * stores parameter metadata resolved by {@linkcode resolveParameters}.
 *
 * @module
 */
import type { Constructor } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';
import { protoToCtor } from '../internal.ts';
import type { ParameterMetadata } from '../metadata/metadata-store.ts';

/**
 * Creates a custom class or method decorator that stores metadata readable
 * by the DecoratorPlugin and custom decorator handlers.
 *
 * At registration, for each registered `DecoratorHandler` whose name matches,
 * the handler is invoked with `(metadata, target, propertyKey?)`.
 *
 * @param name - Unique decorator name (convention: `plugin-name:decorator`)
 * @param metadata - Arbitrary metadata payload
 * @returns A class or method decorator
 * @example
 * ```typescript
 * export const Cacheable = (ttl: number) => createDecorator('cache:cacheable', { ttl });
 * ```
 * @since 0.1.0
 */
export function createDecorator(
  name: string,
  metadata: Readonly<Record<string, unknown>>,
): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    const ctor: Constructor = propertyKey === undefined
      ? target as unknown as Constructor
      : protoToCtor(target);
    if (propertyKey === undefined) {
      metadataStore.addCustomDecorator({ name, metadata, target: ctor });
    } else {
      metadataStore.addCustomDecorator({
        name,
        metadata,
        target: ctor,
        propertyKey: String(propertyKey),
      });
    }
  };
}

/**
 * Creates a custom parameter decorator that stores metadata for the
 * {@linkcode resolveParameters} resolver. The parameter is resolved at request
 * time by a resolver registered under `name` via
 * {@linkcode registerParameterResolver}.
 *
 * @param name - Unique parameter decorator type name
 * @param metadata - Optional metadata payload
 * @returns A parameter decorator
 * @example
 * ```typescript
 * export const CurrentTenant = () => createParameterDecorator('current-tenant');
 * ```
 * @since 0.1.0
 */
export function createParameterDecorator(
  name: string,
  metadata?: Readonly<Record<string, unknown>>,
): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    const param: ParameterMetadata = {
      index: parameterIndex,
      type: 'custom',
      customType: name,
    };
    if (metadata !== undefined) {
      param.metadata = metadata;
    }
    metadataStore.storeParam(protoToCtor(target), String(propertyKey), param);
  };
}
