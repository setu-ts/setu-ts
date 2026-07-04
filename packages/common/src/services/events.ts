/**
 * Domain event contracts, fulfilled by the EventsPlugin under
 * `CAPABILITIES.EVENTS`.
 *
 * The event bus is in-memory and in-process; for cross-service events use
 * the messaging capability.
 *
 * @module
 */

/**
 * A domain event.
 *
 * @typeParam T - The event payload type
 * @since 0.1.0
 */
export interface IDomainEvent<T = unknown> {
  /** Event type name (e.g. `"UserCreated"`). */
  readonly type: string;
  /** Unique event ID. */
  readonly id: string;
  /** When the event occurred. */
  readonly occurredOn: Date;
  /** The event payload. */
  readonly data: T;
  /** ID of the aggregate that produced the event, when applicable. */
  readonly aggregateId?: string;
  /** Aggregate version, for event-sourced aggregates. */
  readonly version?: number;
}

/**
 * Handles one event type.
 *
 * @typeParam T - The event payload type
 * @param event - The published event
 * @since 0.1.0
 */
export type EventHandler<T = unknown> = (event: IDomainEvent<T>) => void | Promise<void>;

/**
 * Removes a subscription when called.
 *
 * @since 0.1.0
 */
export type Unsubscribe = () => void;

/**
 * In-memory publish/subscribe event bus for domain events.
 *
 * @example
 * ```typescript
 * const events = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
 * events.subscribe<UserCreated>('UserCreated', async (event) => {
 *   await sendWelcomeEmail(event.data.email);
 * });
 * ```
 * @since 0.1.0
 */
export interface IEventBus {
  /**
   * Publishes an event to every subscriber of its type.
   *
   * @typeParam T - The event payload type
   * @param event - The event to publish
   */
  publish<T>(event: IDomainEvent<T>): Promise<void>;
  /**
   * Subscribes to an event type.
   *
   * @typeParam T - The event payload type
   * @param type - Event type name
   * @param handler - Invoked for each published event of the type
   * @returns Call to remove the subscription
   */
  subscribe<T>(type: string, handler: EventHandler<T>): Unsubscribe;
}
