/**
 * Aggregate-local domain event recording.
 *
 * @module
 */
import type { IDomainEvent } from '@setu-ts/common';

/**
 * Records domain facts raised by one aggregate during its current operation.
 *
 * The recorder is local state only: application code decides when durable
 * state is saved, whether pending events are dispatched or persisted, and
 * when they are removed. It never publishes to an event bus itself.
 *
 * @example
 * ```typescript
 * class Order {
 *   readonly events = createDomainEvents();
 *
 *   place(): void {
 *     this.events.record(new OrderPlaced());
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export interface IDomainEvents {
  /**
   * Appends an event reference to the pending facts in insertion order.
   *
   * @typeParam T - The event payload type
   * @param event - The fact raised by this aggregate
   */
  record<T>(event: IDomainEvent<T>): void;

  /**
   * Returns an ordered, read-only snapshot of pending facts.
   *
   * Mutating a returned array cannot change the recorder.
   *
   * @returns A snapshot in record order
   */
  pending(): readonly IDomainEvent[];

  /**
   * Removes the first pending reference that is strictly equal to `event`.
   *
   * Event IDs are not collection identity; duplicate references are valid.
   *
   * @param event - The exact event reference to remove
   * @returns `true` when one matching reference was removed
   */
  remove(event: IDomainEvent): boolean;

  /** Removes all pending facts. */
  clear(): void;
}

/**
 * Creates an aggregate-local domain event recorder.
 *
 * The returned interface intentionally hides its mutable backing collection.
 * Use it as an aggregate field; after an application confirms its own
 * persistence and dispatch policy, it can remove individual facts or clear
 * the recorder.
 *
 * @returns A new empty domain-event recorder
 * @since 0.5.0
 */
export function createDomainEvents(): IDomainEvents {
  const events: IDomainEvent[] = [];

  return {
    record<T>(event: IDomainEvent<T>): void {
      events.push(event);
    },

    pending(): readonly IDomainEvent[] {
      return [...events];
    },

    remove(event: IDomainEvent): boolean {
      const index = events.indexOf(event);
      if (index === -1) return false;

      events.splice(index, 1);
      return true;
    },

    clear(): void {
      events.length = 0;
    },
  };
}
