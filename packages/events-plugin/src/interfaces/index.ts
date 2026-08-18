/**
 * Options and types for the EventsPlugin.
 *
 * @module
 */
import type { IDomainEvent, RegistryFactory } from '@setu-ts/common';
import type { IEventHandler } from '../handlers/event-handler.ts';

/**
 * One event handler and the event type it subscribes to.
 *
 * A PAIR rather than a bare handler because `IEventBus.subscribe(type, handler)` routes
 * on the type string, and an `IEventHandler` carries no type of its own — the emitted
 * handler module declares it as a separate constant.
 *
 * `IEventHandler<unknown>` accepts a concretely-typed handler because `handle` is
 * declared with method syntax, so TypeScript compares its parameter bivariantly even
 * under `strictFunctionTypes` — which is what keeps this list heterogeneous without
 * `any`.
 *
 * @since 0.1.0
 */
export interface EventHandlerRegistration {
  /** Event type name, matching `event.type`. */
  readonly type: string;
  /**
   * The handler to subscribe for that type, or a factory that builds one
   * from the service registry.
   *
   * An instance subscribes during `register()` through `subscribeHandler`.
   * A factory is called at the `onInit` phase — after every plugin has
   * registered — and its result subscribes through the SAME
   * `subscribeHandler`, so the option and the manual route cannot drift.
   */
  readonly handler: IEventHandler<unknown> | RegistryFactory<IEventHandler<unknown>>;
}

/**
 * Options for the EventsPlugin.
 *
 * @since 0.1.0
 */
export interface EventsPluginOptions {
  /**
   * Handlers subscribed to the bus at `register()` time.
   *
   * The declarative alternative to resolving `CAPABILITIES.EVENTS` and calling
   * `subscribeHandler` imperatively — which application code has no phase to do, since
   * `IApplication` exposes no lifecycle hooks and the bus does not exist until this
   * plugin has registered. Both routes go through the same `subscribeHandler`, so
   * neither can drift from the other.
   *
   * The `Unsubscribe` each subscription returns is deliberately dropped: the bus is
   * cleared on shutdown (`onClose`), and there is no caller that could hold the
   * handle.
   *
   * Default: `[]` (no subscriptions).
   *
   * @since 0.1.0
   */
  handlers?: readonly EventHandlerRegistration[];
  /**
   * Dispatch policy for event handlers.
   *
   * - `false` (default): `publish`/`publishBatch` await all handlers before
   *   resolving (deterministic ordering).
   * - `true`: fire-and-forget; `publish` resolves immediately, handler errors
   *   are routed to `errorHandler` asynchronously.
   */
  async?: boolean;
  /**
   * Handler for errors thrown/rejected by event handlers.
   *
   * Defaults to logging via the optional `logger` capability if present, else
   * a no-op. Errors never cause `publish` to reject.
   */
  errorHandler?: (error: unknown, event: IDomainEvent) => void;
}

/**
 * Internal options shape passed into InMemoryEventBus.
 *
 * @since 0.1.0
 */
export interface EventDispatchOptions {
  async: boolean;
  errorHandler: (error: unknown, event: IDomainEvent) => void;
}
