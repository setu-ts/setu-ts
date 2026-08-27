/**
 * The deferred-write accumulator standard member decorators record into.
 *
 * Split out from `context-bridge.ts` so the dependency graph stays acyclic
 * (AI_GUIDELINES §11.3): `metadata-store.ts` drains through this module, and
 * `context-bridge.ts` records through it, so neither has to import the other.
 * The only reference to `MetadataStore` here is `import type`, which is erased
 * at runtime and creates no import cycle.
 *
 * Not exported from the package barrel — this is the mechanism, not the surface.
 *
 * @module
 */
import type { Constructor } from '@setu-ts/common';

import type { MetadataStore } from './metadata-store.ts';

/**
 * A store write captured by a member decorator and replayed once the class is
 * read.
 *
 * @since 0.2.0
 */
export type PendingWrite = (store: MetadataStore, target: Constructor) => void;

/**
 * The shape `context.metadata` presents. Declared structurally rather than
 * imported so this module does not depend on which TypeScript lib version
 * supplies `DecoratorMetadata`.
 *
 * @since 0.2.0
 */
export type MetadataCarrier = Record<PropertyKey, unknown>;

/**
 * Key under which pending writes accumulate on the standard `context.metadata`
 * object.
 *
 * Registered with `Symbol.for` rather than `Symbol()` so the key compares equal
 * across two copies of this package sharing one process — the same reasoning as
 * `CONTEXT_PARAMETER_MARKER` (M64) and `SECURITY_METADATA` in
 * `@setu-ts/common`. A copy-local key would accumulate writes the other copy's
 * store could never find, and every route would vanish with nothing logged.
 */
const PENDING_KEY: symbol = Symbol.for('@setu-ts/decorator-plugin:pending-writes');

/**
 * Resolves the key a class's decorator metadata is installed under.
 *
 * **The fallback arm is load-bearing on Node, not defensive.** Measured on Node
 * v24 running the generated project's own runner (`tsx`): `Symbol.metadata` is
 * `undefined` there, because V8 has not shipped decorators, and the transform
 * installs the metadata object under `Symbol.for('Symbol.metadata')` instead —
 * the registered symbol this falls back to. Deno defines the well-known symbol
 * and uses that. Both were confirmed by reading the class's own symbol keys.
 *
 * So collapsing this to `Symbol.metadata` would leave every Node project unable
 * to find any decorator metadata, while the Deno suite stayed green. It is a
 * separate function rather than an inline `??` so both arms are reachable from
 * a test on either runtime.
 *
 * @param symbolCtor - The `Symbol` constructor to read from
 * @returns The well-known symbol when the runtime defines one, else the
 * registered symbol the downlevel transform uses
 * @since 0.2.0
 */
export function resolveMetadataSymbol(
  symbolCtor: { readonly metadata?: symbol },
): symbol {
  return symbolCtor.metadata ?? Symbol.for('Symbol.metadata');
}

/** The key this runtime's decorator transform installs metadata under. */
const METADATA_SYMBOL: symbol = resolveMetadataSymbol(
  Symbol as unknown as { readonly metadata?: symbol },
);

/**
 * Records a store write from a member decorator, to be replayed when the class
 * is first read.
 *
 * Writes replay in the order they were deferred, which is the order the
 * decorators evaluated — bottom-up within a member, and in source order across
 * members. That ordering is observable (two HTTP verb decorators on one method
 * produce two routes, in that order), so it is preserved rather than normalized.
 *
 * @param metadata - The `context.metadata` object handed to the member decorator
 * @param write - The store write to replay against the constructor
 * @since 0.2.0
 */
export function defer(metadata: MetadataCarrier, write: PendingWrite): void {
  const existing = metadata[PENDING_KEY];
  if (Array.isArray(existing)) {
    (existing as PendingWrite[]).push(write);
    return;
  }
  metadata[PENDING_KEY] = [write];
}

/**
 * Removes and returns every write a class's member decorators deferred, reading
 * the accumulator straight off the class via `Symbol.metadata`.
 *
 * This is why the bridge needs no cooperation from the class decorator: the
 * standard runtime installs `context.metadata` on the constructor itself, so
 * the pending writes are reachable from the class alone. The store drains on
 * read, so a class carrying member decorators but NO class decorator is
 * recorded on any TARGETED read — which is every path the plugin takes. See
 * `context-bridge.ts` for the one case that differs from the legacy form.
 *
 * Splices rather than copying, so a write is applied exactly once no matter how
 * many times the class is read.
 *
 * @param target - The class constructor
 * @returns The deferred writes, in the order they were deferred
 * @since 0.2.0
 */
export function takePending(target: Constructor): readonly PendingWrite[] {
  return takePendingFrom((target as unknown as Record<symbol, unknown>)[METADATA_SYMBOL]);
}

/**
 * Removes and returns the deferred writes held by a metadata carrier directly.
 *
 * A class decorator must drain through this rather than through
 * {@linkcode takePending}: the runtime installs the metadata object on the
 * constructor only AFTER every decorator has run, so at class-decoration time
 * `Class[Symbol.metadata]` is still absent and the carrier is reachable only as
 * `context.metadata`.
 *
 * @param carrier - The `context.metadata` object, or anything else
 * @returns The deferred writes, in the order they were deferred
 * @since 0.2.0
 */
export function takePendingFrom(carrier: unknown): readonly PendingWrite[] {
  if (typeof carrier !== 'object' || carrier === null) {
    return [];
  }
  const pending = (carrier as MetadataCarrier)[PENDING_KEY];
  if (!Array.isArray(pending)) {
    return [];
  }
  return (pending as PendingWrite[]).splice(0, pending.length);
}
