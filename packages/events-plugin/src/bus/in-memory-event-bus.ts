/**
 * In-memory event bus implementation.
 *
 * @module
 */
import type { EventHandler, IDomainEvent, IEventBus } from '@hono-enterprise/common';
import type { EventDispatchOptions } from '../interfaces/index.ts';

/**
 * In-memory publish/subscribe event bus.
 *
 * Implements `IEventBus`. Dispatch policy (`async`/`errorHandler`) is
 * configured at construction. Handler errors are isolated through
 * `errorHandler` and never cause `publish` to reject.
 *
 * @since 0.1.0
 */
export class InMemoryEventBus implements IEventBus {
  private readonly handlers: Map<string, EventHandler[]>;
  private readonly async: boolean;
  private readonly errorHandler: (error: unknown, event: IDomainEvent) => void;
  private readonly pending: Set<Promise<void>>;

  constructor(options: EventDispatchOptions) {
    this.handlers = new Map();
    this.async = options.async;
    this.errorHandler = options.errorHandler;
    this.pending = new Set();
  }

  /**
   * Publishes an event to every subscriber of its type.
   *
   * @typeParam T - The event payload type
   * @param event - The event to publish
   */
  async publish<T>(event: IDomainEvent<T>): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    if (handlers.length === 0) return;

    const dispatch = async () => {
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          this.errorHandler(err, event);
        }
      }
    };

    if (this.async) {
      const p = dispatch().then(() => {
        this.pending.delete(p);
      });
      this.pending.add(p);
      return;
    }

    await dispatch();
  }

  /**
   * Publishes multiple events, each to its own subscribers.
   *
   * @param events - The events to publish, in array order
   */
  async publishBatch(events: IDomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /**
   * Subscribes to an event type.
   *
   * @typeParam T - The event payload type
   * @param type - Event type name
   * @param handler - Invoked for each published event of the type
   * @returns Call to remove the subscription
   */
  subscribe<T>(type: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    const handlers = this.handlers.get(type)!;
    handlers.push(handler as EventHandler);

    return () => {
      const idx = handlers.indexOf(handler as EventHandler);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Removes all subscriptions.
   *
   * Internal method for lifecycle cleanup (NOT on `IEventBus`).
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Resolves once all in-flight fire-and-forget handlers settle.
   *
   * Internal test seam (concrete-class only, NOT on `IEventBus`).
   */
  whenIdle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return Promise.all(this.pending).then(() => {});
  }

  /**
   * Returns the count of subscribed event types (for health reporting).
   */
  get subscriptionCount(): number {
    return this.handlers.size;
  }
}
