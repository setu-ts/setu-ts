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
 * onto `context.metadata`, and the first class decorator to run drains those
 * closures against the constructor. The store's write API is unchanged, and
 * `IMetadataStore` (`@setu-ts/common`) stays keyed by `Constructor` exactly as
 * it is committed — this milestone widens no contract in `common`.
 *
 * Not exported from the package barrel: this is the mechanism, not the surface.
 *
 * @module
 */
import type { Constructor } from '@setu-ts/common';

import { metadataStore } from './metadata-store.ts';
import type { MetadataStore } from './metadata-store.ts';

/**
 * A store write captured by a member decorator and replayed once the class
 * decorator supplies the constructor.
 */
export type PendingWrite = (store: MetadataStore, target: Constructor) => void;

/**
 * Key under which pending writes accumulate on the standard
 * `context.metadata` object.
 *
 * Registered with `Symbol.for` rather than `Symbol()` so the key compares equal
 * across two copies of this package sharing one process — the same reasoning as
 * `CONTEXT_PARAMETER_MARKER` (M64) and `SECURITY_METADATA` in
 * `@setu-ts/common`. A copy-local key would silently accumulate writes that the
 * other copy's class decorator could never find, and every route would vanish
 * with nothing logged.
 */
const PENDING_KEY: symbol = Symbol.for('@setu-ts/decorator-plugin:pending-writes');

/**
 * The shape `context.metadata` presents. Declared structurally rather than
 * imported so this module does not depend on which TypeScript lib version
 * supplies `DecoratorMetadata`.
 */
export type MetadataCarrier = Record<PropertyKey, unknown>;

/**
 * Reads the pending-write list off a metadata carrier, creating it on first
 * use.
 *
 * @param metadata - The `context.metadata` object
 * @returns The mutable pending-write list
 */
function pendingOf(metadata: MetadataCarrier): PendingWrite[] {
  const existing = metadata[PENDING_KEY];
  if (Array.isArray(existing)) {
    return existing as PendingWrite[];
  }
  const created: PendingWrite[] = [];
  metadata[PENDING_KEY] = created;
  return created;
}

/**
 * Defers a store write from a member decorator until the class decorator runs.
 *
 * Writes replay in the order they were deferred, which is the order the
 * decorators evaluated — bottom-up within a member, and in source order across
 * members. That ordering is observable (two HTTP verb decorators on one method
 * produce two routes), so it is preserved rather than normalized.
 *
 * @param metadata - The `context.metadata` object handed to the member decorator
 * @param write - The store write to replay against the constructor
 * @since 0.2.0
 */
export function defer(metadata: MetadataCarrier, write: PendingWrite): void {
  pendingOf(metadata).push(write);
}

/**
 * Drains every write deferred by this class's member decorators into the store,
 * keyed by the constructor.
 *
 * Idempotent: the list is emptied as it is replayed, so it does not matter which
 * of several stacked class decorators runs first, and a class carrying more than
 * one never double-writes. A class whose members are decorated but which carries
 * no class decorator at all never flushes — matching the legacy behaviour, where
 * such a class simply had no entry for the plugin to find.
 *
 * @param target - The class constructor, from the class decorator
 * @param metadata - The `context.metadata` object, from the same decorator
 * @param store - The store to write into; defaults to the package singleton
 * @since 0.2.0
 */
export function flushInto(
  target: Constructor,
  metadata: MetadataCarrier | undefined,
  store: MetadataStore = metadataStore,
): void {
  if (metadata === undefined) {
    return;
  }
  const pending = pendingOf(metadata);
  // Splice rather than iterate-then-clear: a write must never be replayed by a
  // second class decorator on the same class.
  const draining = pending.splice(0, pending.length);
  for (const write of draining) {
    write(store, target);
  }
}

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
    flushInto(target, context.metadata);
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
      flushInto(target, context.metadata);
      onClass(metadataStore, target);
      return;
    }
    const handler = String(context.name);
    defer(context.metadata, (store, target) => {
      onMethod(store, target, handler);
    });
  };
}
