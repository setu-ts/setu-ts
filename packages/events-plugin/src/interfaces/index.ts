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
 * The opt-in event-dispatch observation policy (M98j).
 *
 * Event data, event IDs and aggregate IDs are treated as sensitive: only the
 * exact event types listed in {@linkcode events} are observed, each under its
 * approved display alias, and a type outside the map is neither observed nor
 * counted. Handler function names and identities are never captured — the
 * handlers of one approved type aggregate under the type's single alias. No
 * payload, identifier or thrown value is admitted to the collector at all.
 *
 * "Safe" is a SHAPE, not secret detection: every alias is a string of `1`–`64`
 * UTF-8 bytes containing no control character, and aliases are unique.
 * Approving an exact alias IS authorizing its disclosure.
 *
 * @since 0.8.0
 */
export interface EventsDiagnosticsOptions {
  /**
   * The explicit opt-in, deliberately the LITERAL `true`: an acknowledgement,
   * not a toggle. `enabled: false` (or any other value) is refused when
   * `EventsPlugin(...)` is called; omit `diagnostics` instead.
   */
  readonly enabled: true;
  /**
   * The display alias for THIS bus instance. It never derives from the
   * plugin's `name`, which is registry topology, so an instance is
   * identified only by what the application approved.
   */
  readonly alias: string;
  /**
   * Exact event type → approved alias allowlist. At most 64 entries; aliases
   * must be unique. Types are matched exactly — an unknown type is omitted
   * before capture, and there is no pattern or dynamic handler enumeration.
   */
  readonly events: Readonly<Record<string, string>>;
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
  /**
   * Opt-in event-dispatch observations (M98j). Absent by default: no
   * collector exists, the source answers `disabled`, and dispatch is
   * byte-identical to an unobserved bus. Present, it activates the
   * {@linkcode EventsDiagnosticsOptions} allowlist and the bounded collector.
   */
  diagnostics?: EventsDiagnosticsOptions;
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
