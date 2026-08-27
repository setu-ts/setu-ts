/**
 * The bridge between TC39 standard decorators and the constructor-keyed
 * {@linkcode MetadataStore}.
 *
 * A standard **member** decorator never receives the class constructor — it is
 * called while the class is still being defined, and `context.addInitializer`
 * runs per instance, long after `DecoratorPlugin.register()` has already read
 * the store. A standard **class** decorator, by contrast, receives both the
 * constructor and the very same `context.metadata` object its members wrote
 * into.
 *
 * So member decorators do not write to the store directly. They defer a closure
 * onto `context.metadata` (see `pending.ts`), which the standard runtime
 * installs on the constructor itself — so the store can drain those closures on
 * its first read of the class, with no cooperation from any class decorator.
 * That is what keeps a class carrying member decorators but no class decorator
 * behaving as it did under the legacy form.
 *
 * The store's write API is unchanged, and `IMetadataStore` (`@setu-ts/common`)
 * stays keyed by `Constructor` exactly as it is committed — this milestone
 * widens no contract in `common`.
 *
 * Not exported from the package barrel: this is the mechanism, not the surface.
 *
 * @module
 */
import type { Constructor } from '@setu-ts/common';

import { metadataStore } from './metadata-store.ts';
import type { MetadataStore } from './metadata-store.ts';
import { defer, takePendingFrom } from './pending.ts';

/**
 * A store write captured by a member decorator and replayed once the class
 * decorator supplies the constructor.
 */
/**
 * A standard class decorator that records metadata and leaves the class as it
 * is. Returning nothing means the class is never replaced, which is what keeps
 * a decorated class identical to its undecorated self at runtime.
 *
 * @since 0.2.0
 */
export type SetuClassDecorator = (value: unknown, context: ClassDecoratorContext) => void;

/**
 * A standard method decorator that records metadata and leaves the method as it
 * is.
 *
 * @since 0.2.0
 */
export type SetuMethodDecorator = (
  value: unknown,
  context: ClassMethodDecoratorContext,
) => void;

/**
 * A standard decorator valid in either the class or the method position,
 * discriminating on `context.kind`.
 *
 * @since 0.2.0
 */
export type SetuClassOrMethodDecorator = (
  value: unknown,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Applies a class's deferred member writes at class-decoration time.
 *
 * The store also drains on read, which is what covers a class carrying no class
 * decorator at all. Draining here as well keeps a decorated class fully
 * recorded the moment it is defined, so a target-less read such as
 * `getCustomDecorators()` sees it without anything having read the class first
 * — matching the legacy form, where every write landed eagerly.
 *
 * @param target - The class constructor
 * @param carrier - The `context.metadata` object from the class decorator
 */
function flushCarrier(target: Constructor, carrier: unknown): void {
  for (const write of takePendingFrom(carrier)) {
    write(metadataStore, target);
  }
}

/**
 * Builds a class decorator that writes to the store immediately — a class
 * decorator already holds the constructor, so it needs no deferral. It also
 * drains whatever its members deferred, so any class decorator is sufficient to
 * flush and it does not matter which one runs first.
 *
 * @param write - The store write, given the constructor
 * @returns A standard class decorator
 * @since 0.2.0
 */
export function classDecorator(
  write: (store: MetadataStore, target: Constructor) => void,
): SetuClassDecorator {
  return (value, context): void => {
    const target = value as Constructor;
    flushCarrier(target, context.metadata);
    write(metadataStore, target);
  };
}

/**
 * Builds a method decorator that defers its store write until a class decorator
 * supplies the constructor.
 *
 * @param write - The store write, given the constructor and the method name
 * @returns A standard method decorator
 * @since 0.2.0
 */
export function methodDecorator(
  write: (store: MetadataStore, target: Constructor, handler: string) => void,
): SetuMethodDecorator {
  return (_value, context): void => {
    const handler = String(context.name);
    defer(context.metadata, (store, target) => {
      write(store, target, handler);
    });
  };
}

/**
 * Builds a decorator valid in both the class and the method position.
 *
 * The two positions mean different things — a class-level `@Roles` is the
 * default for every route, a method-level one overrides it — so each gets its
 * own write rather than one write branching internally.
 *
 * @param onClass - The store write for the class position
 * @param onMethod - The store write for the method position
 * @returns A standard class-or-method decorator
 * @since 0.2.0
 */
export function classOrMethodDecorator(
  onClass: (store: MetadataStore, target: Constructor) => void,
  onMethod: (store: MetadataStore, target: Constructor, handler: string) => void,
): SetuClassOrMethodDecorator {
  return (value, context): void => {
    if (context.kind === 'class') {
      const target = value as Constructor;
      flushCarrier(target, context.metadata);
      onClass(metadataStore, target);
      return;
    }
    const handler = String(context.name);
    defer(context.metadata, (store, target) => {
      onMethod(store, target, handler);
    });
  };
}
