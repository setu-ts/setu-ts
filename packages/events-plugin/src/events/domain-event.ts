/**
 * Domain event base class and factory.
 *
 * @module
 */
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { IDomainEvent } from '@hono-enterprise/common';

/**
 * Abstract base class for domain events.
 *
 * Implements `IDomainEvent<T>`. Auto-generates `id` and `occurredOn` from
 * `IRuntimeServices` (never `Date.now()`). Optional `aggregateId`/`version`
 * are omitted from the object when not supplied (honors `exactOptionalPropertyTypes`).
 *
 * @typeParam T - The event payload type
 * @example
 * ```typescript
 * // Raw construction when runtime is in scope
 * class UserCreated extends DomainEvent<{ userId: string }> {
 *   readonly type = 'UserCreated';
 * }
 * const event = new UserCreated(runtime, { userId: '123' });
 * ```
 * @since 0.1.0
 */
export abstract class DomainEvent<T = unknown> implements IDomainEvent<T> {
  abstract readonly type: string;
  readonly id: string;
  readonly occurredOn: Date;
  readonly data: T;

  /**
   * Creates a domain event.
   *
   * @param runtime - Runtime services for uuid/timestamp
   * @param data - The event payload
   * @param opts - Optional aggregate metadata
   */
  constructor(
    runtime: IRuntimeServices,
    data: T,
    opts?: { aggregateId?: string; version?: number },
  ) {
    this.id = runtime.uuid();
    this.occurredOn = new Date(runtime.now());
    this.data = data;
    if (opts?.aggregateId !== undefined) {
      (this as unknown as { aggregateId: string }).aggregateId = opts.aggregateId;
    }
    if (opts?.version !== undefined) {
      (this as unknown as { version: number }).version = opts.version;
    }
  }
}

/**
 * Abstract base class for integration (cross-service) events.
 *
 * An empty semantic subclass of `DomainEvent` — no added fields. The _type
 * identity_ (not a boolean marker) discriminates cross-service events for
 * M14's messaging bridge (`instanceof IntegrationEvent`). The in-memory bus
 * publishes it like any other event.
 *
 * @typeParam T - The event payload type
 * @example
 * ```typescript
 * class UserCreatedIntegration extends IntegrationEvent<{ userId: string }> {
 *   readonly type = 'UserCreated';
 * }
 * ```
 * @since 0.1.0
 */
export abstract class IntegrationEvent<T = unknown> extends DomainEvent<T> {
  protected constructor(
    runtime: IRuntimeServices,
    data: T,
    opts?: { aggregateId?: string; version?: number },
  ) {
    super(runtime, data, opts);
  }
}

/**
 * Runtime-bound abstract bases for ergonomic construction.
 *
 * Call once per app with `ctx.runtime`; returns abstract classes that can be
 * extended and constructed as `new X(data)` without threading runtime.
 *
 * @param runtime - Runtime services
 * @returns Runtime-bound `{ DomainEvent, IntegrationEvent }` abstract bases
 * @example
 * ```typescript
 * const { DomainEvent } = defineDomainEvent(ctx.runtime);
 * class UserCreated extends DomainEvent<{ userId: string }> {
 *   readonly type = 'UserCreated';
 * }
 * const event = new UserCreated({ userId: '123' });
 * ```
 * @since 0.1.0
 */
export function defineDomainEvent(runtime: IRuntimeServices) {
  abstract class DomainEventBound<T = unknown> extends DomainEvent<T> {
    constructor(data: T, opts?: { aggregateId?: string; version?: number }) {
      super(runtime, data, opts);
    }
  }

  abstract class IntegrationEventBound<T = unknown> extends IntegrationEvent<T> {
    constructor(data: T, opts?: { aggregateId?: string; version?: number }) {
      super(runtime, data, opts);
    }
  }

  return {
    DomainEvent: DomainEventBound as unknown as new <T>(
      data: T,
      opts?: { aggregateId?: string; version?: number },
    ) => DomainEvent<T>,
    IntegrationEvent: IntegrationEventBound as unknown as new <T>(
      data: T,
      opts?: { aggregateId?: string; version?: number },
    ) => IntegrationEvent<T>,
  };
}
