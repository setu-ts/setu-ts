/**
 * The `cloudflare:workers` members the guides import, typed as the platform
 * supplies them. The specifier only resolves on a Worker toolchain; `deno check`
 * treated it as untyped, so this is stricter than the gate it replaces. Compile-only.
 *
 * `DurableObject.ctx` is the intersection of the two object-state shapes the
 * package's cores take — `IDurableObjectState` (realtime backplane, distributed
 * lock) and `IIdempotencyObjectState` (idempotency, whose storage adds
 * `setAlarm`). A README's `class X extends DurableObject` passes `this.ctx`
 * straight into a `…ObjectCore` constructor, so `ctx` must be assignable to
 * whichever core it feeds; the intersection satisfies both, and the `fetch`/
 * `alarm` members the subclasses `override` must exist on the base class or the
 * `override` modifier would not type-check.
 * @module
 */
import type {
  IDurableObjectNamespace,
  IDurableObjectState,
  IIdempotencyObjectState,
} from '@setu-ts/cloudflare-plugin';

/** The Worker's bindings and variables. */
export declare const env: Readonly<Record<string, unknown>>;
/** Extends the invocation's lifetime until the promise settles. */
export declare function waitUntil(promise: Promise<unknown>): void;

/**
 * The Durable Object base class a README's exported object extends. `ctx` is the
 * intersection of the two object-state shapes the package's cores take, so a
 * `new …ObjectCore(this.ctx)` call compiles against whichever core it feeds.
 */
export declare class DurableObject {
  readonly ctx: IIdempotencyObjectState & IDurableObjectState;
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

/** The Durable Object namespace binding a README casts an `env` entry to. */
export type { IDurableObjectNamespace };
