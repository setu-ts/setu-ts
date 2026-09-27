/**
 * In-memory event bus implementation.
 *
 * @module
 */
import type { EventHandler, IDomainEvent, IEventBus } from '@setu-ts/common';
import type { EventDispatchOptions } from '../interfaces/index.ts';
import type { EventObservationCollector } from '../diagnostics/event-observations.ts';

/**
 * The per-bus observation attachment (M98j). The plugin attaches its
 * collector here during registration through the helper below; the bus's hot
 * path checks for an attachment before reading clocks or resolving aliases,
 * so an unobserved bus performs exactly one `WeakMap.get` per publish and
 * dispatch is otherwise untouched.
 *
 * @internal
 */
const OBSERVERS = new WeakMap<InMemoryEventBus, EventObservationCollector>();

/**
 * Attaches (or detaches, with `null`) the observation collector for one bus
 * instance. Internal — never a barrel export. Existing constructor signatures
 * are unchanged: a bus an application constructs itself has no collector and
 * is never observed.
 *
 * @param bus - The bus to attach to
 * @param collector - The collector, or `null` to detach
 * @internal
 */
export function attachEventObserver(
  bus: InMemoryEventBus,
  collector: EventObservationCollector | null,
): void {
  if (collector === null) {
    OBSERVERS.delete(bus);
  } else {
    OBSERVERS.set(bus, collector);
  }
}

/**
 * In-memory publish/subscribe event bus.
 *
 * Implements `IEventBus`. Dispatch policy (`async`/`errorHandler`) is
 * configured at construction. Handler errors are isolated through
 * `errorHandler` and never cause `publish` to reject.
 *
 * M98j: when the plugin attached an observation collector, publish entry and
 * each existing handler await are instrumented WITHOUT changing dispatch —
 * no extra subscription, no reordering, no second handler evaluation. A
 * thrown `errorHandler` keeps its existing propagation behavior.
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
    // `type` is read ONCE: dispatch and observation use the same value, so an
    // accessor-typed event runs its getter exactly as often as unobserved and
    // cannot be counted under an alias other than the one it dispatched to.
    const type = event.type;
    const handlers = this.handlers.get(type) ?? [];
    const observer = OBSERVERS.get(this);
    const alias = observer?.aliasFor(type);

    if (observer !== undefined && alias !== undefined) {
      // A no-subscriber publication is still a publication: observed as
      // succeeded with `noSubscribers`, then the unchanged early return.
      if (handlers.length === 0) {
        // One clock read: the settlement reuses the start reading.
        const startedAt = observer.begin(alias, 'publish');
        observer.end(alias, 'publish', startedAt, true, true, startedAt);
        return;
      }
      await this.#dispatchObserved(observer, alias, event, handlers);
      return;
    }

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
   * The observed dispatch: instruments publish entry and each EXISTING
   * handler await. Handler failures count on the handler record and the
   * thrown value still reaches the unchanged `errorHandler`; a thrown
   * `errorHandler` counts a failed publish and keeps its propagation.
   * Async publication resolves before the handlers settle, exactly as the
   * unobserved bus; its publish record settles when the dispatch settles.
   *
   * @param observer - The attached collector
   * @param alias - The already-approved alias for this event type
   * @param event - The event being dispatched
   * @param handlers - The subscribed handlers
   */
  async #dispatchObserved(
    observer: EventObservationCollector,
    alias: string,
    event: IDomainEvent,
    handlers: EventHandler[],
  ): Promise<void> {
    // Every collector call below is non-throwing by contract (a failing
    // clock latches `collection-failed` inside the collector), so no
    // observation can change a result, reject a publish, or reach the
    // application's errorHandler.
    // One clock read per boundary edge: each handler starts at the reading
    // the previous boundary settled at, and the publish settles at the last
    // handler's settlement — 1 + handlers reads per publication.
    const publishStartedAt = observer.begin(alias, 'publish');
    let last: number | null = publishStartedAt;
    const dispatch = async () => {
      for (const handler of handlers) {
        const handlerStartedAt = observer.begin(alias, 'handler', last);
        let failed = false;
        let error: unknown;
        try {
          await handler(event);
        } catch (err) {
          failed = true;
          error = err;
        }
        last = observer.end(alias, 'handler', handlerStartedAt, !failed);
        if (failed) {
          this.errorHandler(error, event);
        }
      }
    };

    if (this.async) {
      // Same settlement shape as the unobserved bus: the fulfilled branch
      // deletes the pending entry; a rejection (a thrown errorHandler) is
      // RETHROWN, so `p` still rejects — it stays unhandled and `whenIdle()`
      // still rejects, exactly as without diagnostics.
      const p = dispatch().then(
        () => {
          this.pending.delete(p);
          observer.end(alias, 'publish', publishStartedAt, true, false, last);
        },
        (err: unknown) => {
          observer.end(alias, 'publish', publishStartedAt, false, false, last);
          throw err;
        },
      );
      this.pending.add(p);
      return;
    }

    try {
      await dispatch();
    } catch (err) {
      observer.end(alias, 'publish', publishStartedAt, false, false, last);
      throw err;
    }
    observer.end(alias, 'publish', publishStartedAt, true, false, last);
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
