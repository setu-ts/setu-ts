/**
 * Class-based event handler adapter.
 *
 * @module
 */
import type { IDomainEvent, IEventBus, Unsubscribe } from '@hono-enterprise/common';

/**
 * Class-based event handler interface.
 *
 * @typeParam T - The event payload type
 * @since 0.1.0
 */
export interface IEventHandler<T = unknown> {
  handle(event: IDomainEvent<T>): void | Promise<void>;
}

/**
 * Adapts a class-based handler to the `EventHandler` function signature and
 * subscribes it to the bus. Returns the `Unsubscribe` function.
 *
 * @typeParam T - The event payload type
 * @param bus - The event bus to subscribe to
 * @param type - Event type name
 * @param handler - Class-based handler instance
 * @returns Unsubscribe function
 * @since 0.1.0
 */
export function subscribeHandler<T>(
  bus: IEventBus,
  type: string,
  handler: IEventHandler<T>,
): Unsubscribe {
  return bus.subscribe<T>(type, (event) => handler.handle(event as IDomainEvent<T>));
}
