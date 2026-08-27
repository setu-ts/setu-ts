/**
 * Custom decorator factory — lets consumers create their own decorators that
 * integrate with the framework.
 *
 * {@linkcode createDecorator} stores class/method metadata replayed against
 * handlers registered via `ctx.decorators.register(name, handler)` (collected
 * under `CAPABILITIES.DECORATOR_HANDLER`).
 *
 * A custom **parameter** source is declared with `Custom(name, metadata?)`
 * inside `@Params(...)`; see `decorators/params.ts`. The TC39 proposal has no
 * parameter position, so there is no parameter-decorator factory here.
 *
 * @module
 */
import { classOrMethodDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassOrMethodDecorator } from '../metadata/context-bridge.ts';

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
): SetuClassOrMethodDecorator {
  return classOrMethodDecorator(
    (store, target) => {
      store.addCustomDecorator({ name, metadata, target });
    },
    (store, target, handler) => {
      store.addCustomDecorator({ name, metadata, target, propertyKey: handler });
    },
  );
}
