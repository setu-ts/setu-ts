/**
 * Options and types for the EventsPlugin.
 *
 * @module
 */
import type { IDomainEvent } from '@hono-enterprise/common';

/**
 * Options for the EventsPlugin.
 *
 * @since 0.1.0
 */
export interface EventsPluginOptions {
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
